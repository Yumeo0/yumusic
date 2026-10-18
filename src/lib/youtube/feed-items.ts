import { YTNodes } from "youtubei.js/web";
import type { Song } from "@/contexts/player-context";
import {
	biggestThumb,
	hiResThumb,
	type ThumbCandidate,
} from "@/lib/utils/utils";
import {
	artistIdOf,
	artistListOf,
	artistNames,
	videoIdOf,
} from "@/lib/youtube/youtube.utils";

/**
 * One card in a home feed row. Carousels mix tracks with playlists, albums
 * and artists; each kind renders its own card and click behavior.
 */
export type FeedItem =
	| { kind: "song"; song: Song }
	| {
			kind: "playlist" | "album";
			id: string;
			title: string;
			subtitle: string;
			thumbnail: string;
	  }
	| {
			kind: "artist";
			id: string;
			name: string;
			subtitle: string;
			thumbnail: string;
	  };

export function lastThumb(urls: ThumbCandidate[] | undefined): string {
	return hiResThumb(biggestThumb(urls)?.url);
}

/** A playable card from a responsive list item (song/video/non-music track). */
function responsiveSong(
	item: YTNodes.MusicResponsiveListItem,
): FeedItem | null {
	const id = videoIdOf(item);
	if (!id) return null;
	return {
		kind: "song",
		song: {
			id,
			title: item.title ?? "Unknown Title",
			artist: artistNames(item),
			artistId: artistIdOf(item),
			artists: artistListOf(item),
			thumbnail: lastThumb(item.thumbnail?.contents),
			duration: item.duration?.text,
		},
	};
}

/** Parses a home/library carousel entry into the app's feed shape. */
export function toFeedItem(
	item: YTNodes.MusicResponsiveListItem | YTNodes.MusicTwoRowItem,
): FeedItem | null {
	if (item.is(YTNodes.MusicResponsiveListItem)) {
		switch (item.item_type) {
			case "song":
			case "video":
			case "non_music_track":
				return responsiveSong(item);
			case "playlist":
			case "album":
				if (!item.id) return null;
				return {
					kind: item.item_type,
					id: item.id,
					title: item.title ?? "Unknown Title",
					subtitle:
						item.item_type === "playlist"
							? (item.item_count ?? item.author?.name ?? "")
							: (item.author?.name ?? item.year ?? ""),
					thumbnail: lastThumb(item.thumbnail?.contents),
				};
			case "artist":
			case "library_artist":
				if (!item.id) return null;
				return {
					kind: "artist",
					id: item.id,
					name: item.name ?? item.title ?? "Unknown Artist",
					subtitle: item.subscribers ?? "Artist",
					thumbnail: lastThumb(item.thumbnail?.contents),
				};
			default:
				return null;
		}
	}

	const thumbnail = lastThumb(item.thumbnail);
	switch (item.item_type) {
		case "song":
		case "video": {
			const id = videoIdOf(item);
			if (!id) return null;
			const authorId = item.author?.channel_id;
			const authorName = item.author?.name;
			const artistList = (item.artists ?? [])
				.filter((a) => a.name)
				.map((a) => ({
					name: a.name,
					id: a.channel_id?.startsWith("UC") ? a.channel_id : undefined,
				}));
			if (artistList.length === 0 && authorName) {
				artistList.push({
					name: authorName,
					id: authorId?.startsWith("UC") ? authorId : undefined,
				});
			}
			return {
				kind: "song",
				song: {
					id,
					title: item.title?.text ?? "Unknown Title",
					artist:
						artistList
							.map((a) => a.name)
							.filter(Boolean)
							.join(", ") ||
						item.subtitle?.text ||
						"",
					artistId:
						artistList.find((a) => a.id)?.id ??
						(authorId?.startsWith("UC") ? authorId : undefined),
					artists: artistList,
					thumbnail,
					duration: undefined,
				},
			};
		}
		case "playlist":
		case "album":
			if (!item.id) return null;
			return {
				kind: item.item_type,
				id: item.id,
				title: item.title?.text || "Unknown Title",
				subtitle: item.subtitle?.text ?? "",
				thumbnail,
			};
		case "artist":
			if (!item.id) return null;
			return {
				kind: "artist",
				id: item.id,
				name: item.title?.text || "Unknown Artist",
				subtitle: item.subscribers ?? item.subtitle?.text ?? "Artist",
				thumbnail,
			};
		default:
			return null;
	}
}
