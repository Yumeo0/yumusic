import type { YTNodes } from "youtubei.js/web";
import type { Song } from "../music/song";
import { biggestThumb, hiResThumb } from "../utils/utils";
import { artistListOf, videoIdOf } from "./youtube.utils";

function hasArtistCredit(artists: Array<{ name: string }>): boolean {
	return artists.some((artist) => {
		const name = artist.name?.trim();
		return !!name && !/^unknown artist$/i.test(name);
	});
}

/** Header-level info used for rows that carry no per-track credit or art. */
export interface RowFallback {
	artists?: Array<{ name: string; id?: string }>;
	thumbnail?: string | null;
}

/**
 * Album rows usually omit both the artist and the artwork (the header holds
 * them), so album pages pass those down as a fallback for rows without them.
 */
export function songFromMusicRow(
	item: YTNodes.MusicResponsiveListItem,
	fallback?: RowFallback,
): Song {
	const artists = artistListOf(item);
	const credit =
		fallback?.artists && !hasArtistCredit(artists) ? fallback.artists : artists;
	const rowThumb = biggestThumb(item.thumbnail?.contents)?.url;
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: credit.map((artist) => artist.name).join(", "),
		artistId: credit.find((artist) => artist.id)?.id,
		artists: credit,
		thumbnail: hiResThumb(rowThumb) || fallback?.thumbnail || "",
		duration: item.duration?.text,
	};
}
