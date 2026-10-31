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
 * Parses a pasted URL, retrying without a scheme — share sheets and some apps
 * hand out "youtu.be/…" / "youtube.com/watch?v=…" without "https://".
 */
function parseUrlLoose(input: string): URL | null {
	const text = input.trim();
	try {
		return new URL(text);
	} catch {
		try {
			return new URL(`https://${text}`);
		} catch {
			return null;
		}
	}
}

/** First path segment that is a valid video id ("/ID", "/ID?t=1"). */
function firstVideoId(pathname: string): string | null {
	const segment = pathname.split("/").find(Boolean);
	return isVideoId(segment) ? segment : null;
}

/**
 * Extracts the video ID from a YouTube URL. Accepts watch links (`?v=`),
 * youtu.be short links, and the shorts/live/embed paths; input without a
 * scheme is tolerated. Anything that isn't a YouTube host (or carries no
 * valid 11-character id) returns null.
 */
export function extractVideoId(url: string): string | null {
	const parsed = parseUrlLoose(url);
	if (!parsed) return null;
	const host = parsed.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
	if (host === "youtu.be") return firstVideoId(parsed.pathname);
	if (host !== "youtube.com" && host !== "music.youtube.com") return null;
	const fromQuery = parsed.searchParams.get("v");
	if (isVideoId(fromQuery)) return fromQuery;
	const [path, id] = parsed.pathname.split("/").filter(Boolean);
	if (path === "shorts" || path === "live" || path === "embed") {
		return isVideoId(id) ? id : null;
	}
	return null;
}

/** A link inside pasted text; trailing prose punctuation is trimmed after. */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/**
 * Video ID of the first YouTube link in pasted text — the text may be a bare
 * link or a message that contains one. Returns null when no YouTube link with
 * a valid ID is present.
 */
export function findVideoId(text: string): string | null {
	const direct = extractVideoId(text);
	if (direct) return direct;
	for (const url of text.match(URL_PATTERN) ?? []) {
		const id = extractVideoId(url.replace(/[),.;!?]+$/, ""));
		if (id) return id;
	}
	return null;
}

/**
 * Linked credits of an item, whichever field youtubei.js filled: songs carry
 * `artists`, UGC videos carry `authors`, and some cards only `author`. Each
 * keeps the channel endpoint from the browse response. De-duplicated by name.
 */
function linkedArtists(
	item: YTNodes.MusicResponsiveListItem,
): Array<{ name: string; id?: string }> {
	const credits = [
		...(item.artists ?? []),
		...(item.authors ?? []),
		...(item.author ? [item.author] : []),
	];
	const artists: Array<{ name: string; id?: string }> = [];
	for (const credit of credits) {
		const name = credit.name?.trim();
		if (!name || artists.some((a) => a.name === name)) continue;
		artists.push({
			name,
			id: credit.channel_id?.startsWith("UC") ? credit.channel_id : undefined,
		});
	}
	return artists;
}

/** Remove type labels and statistics from an unstructured song subtitle. */
export function artistSubtitle(text: string | undefined): string {
	return (text ?? "")
		.split(/\s*[•·]\s*/u)
		.map((part) => part.trim())
		.filter(
			(part) =>
				part &&
				!/^(?:song|video|album|single|ep|playlist)$/iu.test(part) &&
				!/^\d+(?::\d{2}){1,2}$/u.test(part) &&
				!/^[12]\d{3}$/u.test(part) &&
				!/^\d[\d.,\s]*[KMB]?\s*views?$/iu.test(part),
		)
		.join(", ");
}

/** Info-column runs as artist credits, keeping their channel links. */
function infoColumnArtists(
	item: YTNodes.MusicResponsiveListItem,
): Array<{ name: string; id?: string }> {
	const runs = item.flex_columns?.at(1)?.title?.runs ?? [];
	const artists: Array<{ name: string; id?: string }> = [];
	for (const run of runs) {
		const text = artistSubtitle((run as { text?: string }).text);
		if (!text) continue;
		if (/^[•·|,;&+\s]+$/.test(text)) continue; // separators
		if (/^\d+:\d{2}(:\d{2})?$/.test(text)) continue; // duration
		if (/^[12]\d{3}$/.test(text)) continue; // year
		if (/^(song|video|album|single|ep|playlist)$/i.test(text)) continue;
		if (artists.some((a) => a.name === text)) continue;
		const browseId = (run as { endpoint?: { payload?: { browseId?: string } } })
			.endpoint?.payload?.browseId;
		artists.push({
			name: text,
			id: browseId?.startsWith("UC") ? browseId : undefined,
		});
	}
	return artists;
}

/**
 * Builds a display string for the artists of a search/playlist item.
 * youtubei.js parses linked credits into `artists` (songs) or `authors` (UGC
 * videos); when both are missing, fall back to the info column runs
 * (skipping separators, durations, years, etc.).
 */
export function artistNames(item: YTNodes.MusicResponsiveListItem): string {
	const linked = linkedArtists(item);
	if (linked.length > 0) return linked.map((a) => a.name).join(", ");
	const runs = infoColumnArtists(item);
	if (runs.length > 0) return runs.map((a) => a.name).join(", ");
	const subtitle = artistSubtitle(item.subtitle?.toString());
	return subtitle || "Unknown Artist";
}

/** First linked channel id (UC…) of an item's artist credits, when present. */
export function artistIdOf(
	item: YTNodes.MusicResponsiveListItem,
): string | undefined {
	return linkedArtists(item).find((a) => a.id)?.id;
}

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Whether `id` can be a YouTube video id (11 base64url chars). */
export function isVideoId(id: string | undefined | null): id is string {
	return !!id && VIDEO_ID_PATTERN.test(id);
}

/** Whether a browse id refers to an album rather than a playlist. */
export function isAlbumId(id: string | undefined | null): id is string {
	return (
		!!id &&
		(id.startsWith("MPR") ||
			id.startsWith("FEmusic_library_privately_owned_release"))
	);
}

/**
 * Extracts the playable video id from a music list item.
 *
 * `MusicResponsiveListItem.id` is only populated when the response carries
 * `playlistItemData` (playlists, search results), and youtubei.js' video
 * parser does not fall back to the item's watch endpoint — so home shelves
 * can yield items whose `id` is empty or a browse id. The watch endpoint with
 * the real video id lives on the first flex column's runs.
 */
export function videoIdOf(
	item: YTNodes.MusicResponsiveListItem | YTNodes.MusicTwoRowItem,
): string {
	const candidates: (string | undefined)[] = [
		item.id,
		item.endpoint?.payload?.videoId,
	];
	if ("flex_columns" in item) {
		for (const column of item.flex_columns ?? []) {
			for (const run of column.title?.runs ?? []) {
				if ("endpoint" in run) {
					candidates.push(run.endpoint?.payload?.videoId);
				}
			}
		}
	}
	return candidates.find(isVideoId) ?? "";
}

/** All artists of an item as { name, id } pairs (id present when linked). */
export function artistListOf(
	item: YTNodes.MusicResponsiveListItem,
): Array<{ name: string; id?: string }> {
	const linked = linkedArtists(item);
	if (linked.length > 0) return linked;
	const runs = infoColumnArtists(item);
	if (runs.length > 0) return runs;
	return [{ name: artistNames(item) }];
}
