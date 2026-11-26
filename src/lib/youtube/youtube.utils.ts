import type { YTNodes } from "youtubei.js/web";

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
		if (/^[•·|,;&+\s]+$/.test(text)) continue;
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
	return [
		{ name: artistSubtitle(item.subtitle?.toString()) || "Unknown Artist" },
	];
}
