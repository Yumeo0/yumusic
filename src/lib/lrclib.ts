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

/** Only accept records whose duration matches the song within this window. */
const DURATION_TOLERANCE_SEC = 2;

/**
 * Fetches time-synced lyrics from LRCLIB (free, no key, CORS enabled).
 * Uses the app's cleaned title (the same normalization scrobbles use, which
 * strips covers/credits and resolves "Original - Translation" titles), tries an
 * exact artist+track+duration match, then searches by title+artist. When
 * `allowLooseMatch` is set it additionally searches by title alone — more
 * forgiving but can return the wrong version. Records whose duration is not
 * within ±DURATION_TOLERANCE_SEC of the song are rejected — prevents
 * wrong-version lyrics (live/extended) desyncing the panel. Returns null when
 * nothing usable is found; callers re-fetch once the duration becomes known.
 */
export async function fetchSyncedLyrics(
	title: string,
	artist: string,
	durationSec: number,
	allowLooseMatch = true,
): Promise<LrcLine[] | null> {
	const track = cleanSearchTitle(title, artist).trim();
	const name = cleanArtist(artist);
	if (!track || durationSec <= 0) return null;

	try {
		if (name) {
			const res = await fetch(
				`https://lrclib.net/api/get?artist_name=${encodeURIComponent(name)}&track_name=${encodeURIComponent(track)}&duration=${Math.round(durationSec)}`,
			);
			if (res.ok) {
				const data = await res.json();
				if (
					data?.syncedLyrics &&
					Math.abs(data.duration - durationSec) <= DURATION_TOLERANCE_SEC
				) {
					return parseLrc(data.syncedLyrics);
				}
			}
		}

		// Search by title+artist; the title-only pass tolerates a wrong/missing
		// artist (matching on title + duration) but is only used when loose
		// matching is enabled.
		const queries: string[] = [];
		if (name) {
			queries.push(
				`https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(name)}`,
			);
		}
		if (allowLooseMatch || !name) {
			queries.push(
				`https://lrclib.net/api/search?track_name=${encodeURIComponent(track)}`,
			);
		}

		for (const url of queries) {
			const res = await fetch(url);
			if (!res.ok) continue;
			const results = (await res.json()) as Array<{
				duration: number;
				syncedLyrics?: string | null;
			}>;
			const candidates = results.filter(
				(r) =>
					r.syncedLyrics &&
					Math.abs(r.duration - durationSec) <= DURATION_TOLERANCE_SEC,
			);
			if (candidates.length === 0) continue;
			// Closest duration wins; on a tie keep LRCLIB's own (relevance)
			// order — e.g. the original-language entry ranked above a translated
			// one of the same length.
			const best = candidates.reduce((a, b) =>
				Math.abs(a.duration - durationSec) <= Math.abs(b.duration - durationSec)
					? a
					: b,
			);
			return parseLrc(best.syncedLyrics ?? "");
		}
		return null;
	} catch {
		return null;
	}
}
