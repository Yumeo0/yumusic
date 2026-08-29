import type { YTNodes } from "youtubei.js/web";

/**
 * Validates if a URL is a valid YouTube or YouTube Music URL
 * @param url - The URL to validate
 * @returns true if the URL is a valid YouTube URL, false otherwise
 */
export function isValidYouTubeUrl(url: string): boolean {
	try {
		const patterns = [
			/^(https?:\/\/)?(www\.)?(music\.)?youtube\.com\/.+/,
			/^(https?:\/\/)?(www\.)?youtu\.be\/.+/,
		];
		return patterns.some((pattern) => pattern.test(url));
	} catch {
		return false;
	}
}

/**
 * Extracts the video ID from a YouTube URL
 * @param url - The YouTube URL to extract the video ID from
 * @returns The video ID if found, null otherwise
 */
export function extractVideoId(url: string): string | null {
	try {
		const urlObj = new URL(url);

		// Handle youtu.be short URLs
		if (urlObj.hostname === "youtu.be") {
			return urlObj.pathname.slice(1);
		}

		// Handle standard YouTube and YouTube Music URLs
		if (
			urlObj.hostname.includes("youtube.com") ||
			urlObj.hostname.includes("music.youtube.com")
		) {
			return urlObj.searchParams.get("v");
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Builds a display string for the artists of a search/playlist item.
 * youtubei.js only parses `artists` when the runs carry channel links,
 * which frequently fails for multi-artist songs — so fall back to the
 * info column runs (skipping separators, durations, years, etc.).
 */
export function artistNames(item: YTNodes.MusicResponsiveListItem): string {
	const linked = item.artists?.map((a) => a.name).filter(Boolean) ?? [];
	if (linked.length > 0) return linked.join(", ");

	const runs = item.flex_columns?.at(1)?.title?.runs ?? [];
	const parts: string[] = [];
	for (const run of runs) {
		const text = (run as { text?: string }).text?.trim() ?? "";
		if (!text) continue;
		if (/^[•·|,;&+\s]+$/.test(text)) continue; // separators
		if (/^\d+:\d{2}(:\d{2})?$/.test(text)) continue; // duration
		if (/^[12]\d{3}$/.test(text)) continue; // year
		if (/^(song|video|album|single|ep|playlist)$/i.test(text)) continue;
		if (parts.includes(text)) continue;
		parts.push(text);
	}
	if (parts.length > 0) return parts.join(", ");

	const subtitle = item.subtitle?.toString().trim();
	return subtitle || "Unknown Artist";
}

/** First linked artist channel id (UC…) of an item, when present. */
export function artistIdOf(
	artists?: { channel_id?: string | undefined }[] | undefined,
): string | undefined {
	return artists?.find((a) => a.channel_id?.startsWith("UC"))?.channel_id;
}

/** All artists of an item as { name, id } pairs (id present when linked). */
export function artistListOf(
	item: YTNodes.MusicResponsiveListItem,
): Array<{ name: string; id?: string }> {
	const linked = (item.artists ?? [])
		.filter((a) => a.name)
		.map((a) => ({
			name: a.name,
			id: a.channel_id?.startsWith("UC") ? a.channel_id : undefined,
		}));
	if (linked.length > 0) return linked;
	return [{ name: artistNames(item) }];
}
