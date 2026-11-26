import { type Innertube, YTNodes } from "youtubei.js/web";
import type { Song } from "@/lib/music/song";
import {
	biggestThumb,
	hiResThumb,
	type ThumbCandidate,
} from "@/lib/utils/utils";
import {
	artistSubtitle,
	isVideoId,
	videoIdOf,
} from "@/lib/youtube/youtube.utils";
import { songFromMusicRow } from "./music-row";

export type HomeFeed = Awaited<ReturnType<Innertube["music"]["getHomeFeed"]>>;

/**
 * One card in a home feed row. Carousels mix tracks with playlists, albums,
 * artists and browse chips; each kind renders its own card and click behavior.
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
	  }
	/** A moods/genres chip; opens a search rather than a detail page. */
	| { kind: "navigation"; label: string };

export interface HomeSection {
	title: string;
	items: FeedItem[];
}

/** Stable identity of an entry, for keys and continuation de-duplication. */
export function feedItemKey(item: FeedItem): string {
	if (item.kind === "song") return `song:${item.song.id}`;
	if (item.kind === "navigation") {
		return `navigation:${item.label.trim().toLowerCase()}`;
	}
	return `${item.kind}:${item.id}`;
}

function lastThumb(urls: ThumbCandidate[] | undefined): string {
	return hiResThumb(biggestThumb(urls)?.url);
}

export function feedSongs(sections: HomeSection[]): Song[] {
	return sections.flatMap((section) =>
		section.items.flatMap((item) => (item.kind === "song" ? [item.song] : [])),
	);
}

function responsiveSong(
	item: YTNodes.MusicResponsiveListItem,
): FeedItem | null {
	const song = songFromMusicRow(item);
	return song.id ? { kind: "song", song } : null;
}

function responsiveFeedItem(
	item: YTNodes.MusicResponsiveListItem,
): FeedItem | null {
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

function twoRowFeedItem(item: YTNodes.MusicTwoRowItem): FeedItem | null {
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
						artistSubtitle(item.subtitle?.text) ||
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

/**
 * Parses a multi-row shelf entry. YouTube Music uses these for mixed-in
 * personalised cards (playlists with a description, occasional tracks) that
 * the simpler row parsers leave empty.
 */
function multiRowFeedItem(
	item: YTNodes.MusicMultiRowListItem,
): FeedItem | null {
	const payload = item.on_tap?.payload;
	const title = item.title?.toString().trim() || "Unknown Title";
	const subtitle =
		item.subtitle?.toString().trim() ||
		item.second_title?.toString().trim() ||
		item.description?.toString().trim() ||
		"";
	const thumbnail = lastThumb(item.thumbnail?.contents);

	const videoId = payload?.videoId;
	if (isVideoId(videoId)) {
		return {
			kind: "song",
			song: {
				id: videoId,
				title,
				artist: artistSubtitle(subtitle) || "Unknown Artist",
				thumbnail,
			},
		};
	}

	const browseId = payload?.browseId;
	if (!browseId) return null;
	const pageType =
		payload?.browseEndpointContextSupportedConfigs
			?.browseEndpointContextMusicConfig?.pageType;
	if (pageType === "MUSIC_PAGE_TYPE_ARTIST" && browseId.startsWith("UC")) {
		return {
			kind: "artist",
			id: browseId,
			name: title,
			subtitle: subtitle || "Artist",
			thumbnail,
		};
	}
	return {
		kind: pageType === "MUSIC_PAGE_TYPE_ALBUM" ? "album" : "playlist",
		id: browseId,
		title,
		subtitle,
		thumbnail,
	};
}

/** Parses a mood/genre browse chip. */
function navigationFeedItem(
	item: YTNodes.MusicNavigationButton,
): FeedItem | null {
	const label = item.button_text?.trim();
	return label ? { kind: "navigation", label } : null;
}

/** Parses any entry a home-feed carousel can contain. */
function toFeedItem(
	item:
		| YTNodes.MusicResponsiveListItem
		| YTNodes.MusicTwoRowItem
		| YTNodes.MusicMultiRowListItem
		| YTNodes.MusicNavigationButton,
): FeedItem | null {
	if (item.is(YTNodes.MusicResponsiveListItem)) {
		return responsiveFeedItem(item);
	}
	if (item.is(YTNodes.MusicTwoRowItem)) {
		return twoRowFeedItem(item);
	}
	if (item.is(YTNodes.MusicMultiRowListItem)) {
		return multiRowFeedItem(item);
	}
	if (item.is(YTNodes.MusicNavigationButton)) {
		return navigationFeedItem(item);
	}
	return null;
}

/** Converts one home-feed page into the app's section shape. */
export function homeSectionsFromFeed(feed: HomeFeed): HomeSection[] {
	const sections: HomeSection[] = [];
	for (const section of feed.sections ?? []) {
		// Tastebuilder shelves are an onboarding prompt, not a content row.
		if (!section.is(YTNodes.MusicCarouselShelf)) continue;
		const title = section.header?.title?.text || "";
		const items: FeedItem[] = [];
		for (const item of section.contents ?? []) {
			const feedItem = toFeedItem(item);
			if (feedItem) items.push(feedItem);
		}
		if (items.length > 0) sections.push({ title, items });
	}
	return sections;
}
