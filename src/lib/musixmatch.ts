import { lyricsClient } from "@mjba/lyrics";
import type { LrcLine } from "./lrclib";

/** Strips noise YouTube appends to titles (shared with the LRCLIB fetcher). */
function cleanTitle(title: string): string {
	return title
		.replace(/[([{][^)\]}]*[)\]}]/g, "")
		.replace(/\s*feat\..*$/i, "")
		.trim();
}

/**
 * Fetches time-synced lyrics from Musixmatch via @mjba/lyrics.
 * Returns null when no synced lyrics are found or the request fails
 * (the Musixmatch endpoint may reject browser requests).
 */
export async function fetchMusixmatchSynced(
	title: string,
	artist: string,
): Promise<LrcLine[] | null> {
	const track = cleanTitle(title);
	if (!track) return null;
	try {
		const res = await lyricsClient.searchSynced(`${artist} ${track}`);
		if (res.success && res.syncedLyrics && res.syncedLyrics.length > 0) {
			return res.syncedLyrics
				.map((l) => ({ time: l.time.total, text: l.text }))
				.sort((a, b) => a.time - b.time);
		}
		return null;
	} catch (error) {
		console.warn("[musixmatch] failed to fetch lyrics:", error);
		return null;
	}
}
