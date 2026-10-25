import { type FeedItem, feedItemKey } from "./feed-items";
import { getHomeFeed } from "./home-feed-cache";

/** How many personalised entries the search bar suggests. */
const MAX_RECOMMENDATIONS = 8;

/**
 * A personalised mix of tracks, artists, albums and playlists for the search
 * bar's empty state — sampled from the YouTube Music home feed. Reads the same
 * cached feed as the home page, so opening the search bar first does not cost
 * an extra request and both views agree on what is recommended.
 */
export async function getSearchRecommendations(): Promise<FeedItem[]> {
	const { sections } = await getHomeFeed();
	const items: FeedItem[] = [];
	const seen = new Set<string>();
	for (const section of sections) {
		for (const feedItem of section.items) {
			// Browse chips are not playable/openable picks.
			if (feedItem.kind === "navigation") continue;
			const key = feedItemKey(feedItem);
			if (seen.has(key)) continue;
			seen.add(key);
			items.push(feedItem);
			if (items.length >= MAX_RECOMMENDATIONS) return items;
		}
	}
	return items;
}
