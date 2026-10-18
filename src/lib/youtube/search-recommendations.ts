import { YTNodes } from "youtubei.js/web";
import { type FeedItem, toFeedItem } from "./feed-items";
import { getYoutubeClient } from "./youtube-client";

/** How many personalised entries the search bar suggests. */
const MAX_RECOMMENDATIONS = 8;

let cached: Promise<FeedItem[]> | null = null;

/**
 * A personalised mix of tracks, artists, albums and playlists for the search
 * bar's empty state — sampled from the YouTube Music home feed. The promise is
 * shared for the session (the feed is locale-stable enough for suggestions);
 * a failed load clears the cache so focusing the bar again retries.
 */
export function getSearchRecommendations(): Promise<FeedItem[]> {
	if (!cached) {
		cached = loadRecommendations().catch((error) => {
			cached = null;
			throw error;
		});
	}
	return cached;
}

async function loadRecommendations(): Promise<FeedItem[]> {
	const client = await getYoutubeClient();
	const feed = await client.music.getHomeFeed();
	const items: FeedItem[] = [];
	const seen = new Set<string>();
	for (const section of feed.sections ?? []) {
		if (!section.is(YTNodes.MusicCarouselShelf)) continue;
		for (const item of section.contents ?? []) {
			if (!item.is(YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem))
				continue;
			const feedItem = toFeedItem(item);
			if (!feedItem) continue;
			const id = feedItem.kind === "song" ? feedItem.song.id : feedItem.id;
			const key = `${feedItem.kind}:${id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			items.push(feedItem);
			if (items.length >= MAX_RECOMMENDATIONS) return items;
		}
	}
	return items;
}
