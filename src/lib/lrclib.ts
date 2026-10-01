import { cleanSearchTitle } from "./title";

export interface LrcLine {
	/** Start time in seconds */
	time: number;
	text: string;
}

const TIME_TOKEN = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Parses an LRC string into sorted, offset-applied lines. */
export function parseLrc(lrc: string): LrcLine[] {
	const lines: LrcLine[] = [];
	let offsetMs = 0;

	for (const raw of lrc.split("\n")) {
		const meta = raw.match(
			/^\s*\[(ar|ti|al|by|offset|re|ve|length):(.*)\]\s*$/i,
		);
		if (meta) {
			if (meta[1].toLowerCase() === "offset") {
				offsetMs = Number.parseInt(meta[2], 10) || 0;
			}
			continue;
		}
		const timestamps = [...raw.matchAll(TIME_TOKEN)];
		if (timestamps.length === 0) continue;
		const text = raw.replace(TIME_TOKEN, "").trim();
		for (const t of timestamps) {
			const min = Number.parseInt(t[1], 10);
			const sec = Number.parseInt(t[2], 10);
			const frac = t[3] ? Number.parseInt(t[3].padEnd(3, "0"), 10) : 0;
			lines.push({ time: min * 60 + sec + frac / 1000, text });
		}
	}

	return lines
		.map((line) => ({
			...line,
			time: Math.max(0, line.time + offsetMs / 1000),
		}))
		.sort((a, b) => a.time - b.time);
}

/** Takes the primary artist and strips the " - Topic" channel suffix. */
function cleanArtist(artist: string): string {
	return artist
		.split(/,|&/)[0]
		.replace(/\s*-\s*topic$/i, "")
		.trim();
}

/** Confirmed (artist+title) matches may drift by this much. */
const DURATION_TOLERANCE_SEC = 2;
/** Loose (title-only) matches get a little more wiggle to be found… */
const LOOSE_DURATION_TOLERANCE_SEC = 5;
/** …but are only shown synced when this close; otherwise unsynced. */
const LOOSE_SYNCED_TOLERANCE_SEC = 1;

export interface LrclibLyrics {
	synced: LrcLine[] | null;
	plain: string | null;
	/** Matched on artist + title rather than a loose title-only match. */
	confirmed: boolean;
}

interface LrclibRecord {
	duration: number;
	syncedLyrics?: string | null;
	plainLyrics?: string | null;
}

/** Plain text for a record: its plainLyrics, else the timed lines stripped. */
function toPlain(record: LrclibRecord): string | null {
	const plain = record.plainLyrics?.trim();
	if (plain) return plain;
	if (!record.syncedLyrics) return null;
	const lines = record.syncedLyrics
		.split("\n")
		.map((line) => line.replace(TIME_TOKEN, "").trim())
		.filter((line) => line.length > 0);
	return lines.length > 0 ? lines.join("\n") : null;
}

/** Best record for a query: prefer one that carries timed lyrics, then the
 * closest duration; ties keep LRCLIB's own (relevance) order. */
async function bestRecord(
	url: string,
	durationSec: number,
	tolerance: number,
): Promise<LrclibRecord | null> {
	const res = await fetch(url);
	if (!res.ok) return null;
	const results = (await res.json()) as LrclibRecord[];
	const candidates = results.filter(
		(record) =>
			Math.abs(record.duration - durationSec) <= tolerance &&
			(record.syncedLyrics || record.plainLyrics),
	);
	if (candidates.length === 0) return null;
	return candidates.reduce((a, b) => {
		const aSynced = a.syncedLyrics ? 1 : 0;
		const bSynced = b.syncedLyrics ? 1 : 0;
		if (aSynced !== bSynced) return aSynced > bSynced ? a : b;
		return Math.abs(a.duration - durationSec) <=
			Math.abs(b.duration - durationSec)
			? a
			: b;
	});
}

/**
 * Fetches time-synced lyrics from LRCLIB (free, no key, CORS enabled).
 * Uses the app's cleaned title (the same normalization scrobbles use, which
 * strips covers/credits and resolves "Original - Translation" titles), tries an
 * exact artist+track+duration match, then searches by title+artist. When
 * `allowLooseMatch` is set it additionally searches by title alone — more
 * forgiving but can match the wrong version. A loose match is only returned as
 * synced when its length is within LOOSE_SYNCED_TOLERANCE_SEC; otherwise the
 * lyrics are returned as unsynced text so they can't desync. Returns null when
 * nothing usable is found; callers re-fetch once the duration becomes known.
 */
export async function fetchSyncedLyrics(
	title: string,
	artist: string,
	durationSec: number,
	allowLooseMatch = true,
): Promise<LrclibLyrics | null> {
	const track = cleanSearchTitle(title, artist).trim();
	const name = cleanArtist(artist);
	if (!track || durationSec <= 0) return null;

	const confirmedResult = (record: LrclibRecord): LrclibLyrics => {
		if (record.syncedLyrics) {
			return {
				synced: parseLrc(record.syncedLyrics),
				plain: null,
				confirmed: true,
			};
		}
		return { synced: null, plain: toPlain(record), confirmed: true };
	};

	try {
		// Exact artist+track+duration match.
		if (name) {
			const res = await fetch(
				`https://lrclib.net/api/get?artist_name=${encodeURIComponent(name)}&track_name=${encodeURIComponent(track)}&duration=${Math.round(durationSec)}`,
			);
			if (res.ok) {
				const record = (await res.json()) as LrclibRecord;
				if (Math.abs(record.duration - durationSec) <= DURATION_TOLERANCE_SEC) {
					return confirmedResult(record);
				}
			}
		}

		// Confirmed search: title + artist.
		if (name) {
			const record = await bestRecord(
				`https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(name)}`,
				durationSec,
				DURATION_TOLERANCE_SEC,
			);
			if (record) return confirmedResult(record);
		}

		// Loose search: title alone.
		if (allowLooseMatch) {
			const record = await bestRecord(
				`https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}`,
				durationSec,
				LOOSE_DURATION_TOLERANCE_SEC,
			);
			if (record) {
				const delta = Math.abs(record.duration - durationSec);
				if (record.syncedLyrics && delta <= LOOSE_SYNCED_TOLERANCE_SEC) {
					return {
						synced: parseLrc(record.syncedLyrics),
						plain: null,
						confirmed: false,
					};
				}
				const plain = toPlain(record);
				if (plain) return { synced: null, plain, confirmed: false };
			}
		}

		return null;
	} catch {
		return null;
	}
}
