import { proxiedFetch, USER_AGENT } from "../utils/tauri";
import { cleanSearchTitle } from "../utils/title";
import { parseLrc, stripLrcTimestamps } from "./lrc";
import type { ProviderLyrics } from "./lyrics";

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

interface LrclibRecord {
	id: number;
	name: string;
	trackName: string;
	artistName: string;
	albumName: string;
	duration: number;
	instrumental: boolean;
	hasWordSync: boolean;
	syncedLyrics: string | null;
	plainLyrics: string | null;
	lyricsfile: string;
}

/** Plain text for a record: its plainLyrics, else the timed lines stripped. */
function toPlain(record: LrclibRecord): string | null {
	const plain = record.plainLyrics?.trim();
	if (plain) return plain;
	if (!record.syncedLyrics) return null;
	const lines = stripLrcTimestamps(record.syncedLyrics)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Records carrying a non-zero `[offset:…]` are corrected copies of one
 * upload; when LRCLIB holds duplicates, the clean copy usually matches the
 * video. They are penalized in ranking, not excluded — without a clean
 * candidate an offset record still wins.
 */
const OFFSET_RANKING_PENALTY_SEC = 1;

function hasNonZeroOffset(record: LrclibRecord): boolean {
	const offset = record.syncedLyrics?.match(/\[offset:\s*([+-]?\d+)\s*\]/i);
	return offset != null && Number.parseInt(offset[1], 10) !== 0;
}

/** Ranking distance: duration delta, penalizing offset-carrying copies. */
function rankingDistance(record: LrclibRecord, durationSec: number): number {
	return (
		Math.abs(record.duration - durationSec) +
		(hasNonZeroOffset(record) ? OFFSET_RANKING_PENALTY_SEC : 0)
	);
}

/** Best record for a query: prefer one that carries timed lyrics, then the
 * closest duration; ties keep LRCLIB's own (relevance) order. */
async function bestRecord(
	url: string,
	durationSec: number,
	tolerance: number,
): Promise<LrclibRecord | null> {
	const res = await proxiedFetch(url, { "User-Agent": USER_AGENT });
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
		return rankingDistance(a, durationSec) <= rankingDistance(b, durationSec)
			? a
			: b;
	});
}

/**
 * Fetches time-synced lyrics from LRCLIB (free, no key, CORS enabled).
 * Uses the app's cleaned title (the same normalization scrobbles use, which
 * strips covers/credits and resolves "Original - Translation" titles) and
 * ranks artist+title search results — synced first, then closest duration,
 * with offset-carrying duplicates penalized. When `allowLooseMatch` is set it
 * additionally searches by title alone — more forgiving but can match the
 * wrong version. A loose match is only returned as synced when its length is
 * within LOOSE_SYNCED_TOLERANCE_SEC; otherwise the lyrics are returned as
 * unsynced text so they can't desync. Returns null when nothing usable is
 * found; callers re-fetch once the duration becomes known.
 */
export async function fetchSyncedLyrics(
	title: string,
	artist: string,
	durationSec: number,
	allowLooseMatch = true,
): Promise<ProviderLyrics | null> {
	const track = cleanSearchTitle(title, artist).trim();
	const name = cleanArtist(artist);
	if (!track || durationSec <= 0) return null;

	const confirmedResult = (record: LrclibRecord): ProviderLyrics => {
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
		// Confirmed search: title + artist. The single-record /api/get lookup
		// is deliberately not used: with duplicate uploads it returns an
		// arbitrary one (often an old copy with a bogus offset), while the
		// ranked search picks the cleanest.
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
