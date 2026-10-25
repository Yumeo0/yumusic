import type { Song } from "@/contexts/player-context";
import type { HomeSection } from "./feed-items";
import { homeSectionsFromFeed, withUpdatedSong } from "./feed-items";
import { getYoutubeClient, type HomeFeed } from "./youtube-client";

/**
 * Home recommendations change slowly, so a snapshot is reused instead of
 * refetching every time the home page remounts (e.g. switching tabs). Thirty
 * minutes keeps the feed feeling current without a request on every visit.
 */
export const HOME_FEED_TTL_MS = 30 * 60 * 1000;

export interface HomeFeedSnapshot {
	/** Live feed handle; still valid for continuation requests while cached. */
	feed: HomeFeed;
	/** Parsed sections of the first page. */
	sections: HomeSection[];
}

interface CacheEntry extends HomeFeedSnapshot {
	timestamp: number;
}

let entry: CacheEntry | null = null;
/** In-flight load shared by concurrent callers. */
let inFlight: Promise<HomeFeedSnapshot> | null = null;

function isFresh(cached: CacheEntry | null): cached is CacheEntry {
	return !!cached && Date.now() - cached.timestamp < HOME_FEED_TTL_MS;
}

/**
 * The cached first page while it is still fresh, otherwise null. Lets a view
 * paint the previous feed immediately instead of flashing its skeleton when
 * navigating back within the TTL.
 */
export function readCachedHomeFeed(): HomeSection[] | null {
	return isFresh(entry) ? entry.sections : null;
}

/**
 * Returns the home feed's first page, reusing a snapshot fetched less than
 * {@link HOME_FEED_TTL_MS} ago. Concurrent callers share one request; a failed
 * load is not cached, so the next visit retries.
 */
export async function getHomeFeed(): Promise<HomeFeedSnapshot> {
	if (isFresh(entry)) return entry;
	if (!inFlight) {
		inFlight = loadHomeFeed().finally(() => {
			inFlight = null;
		});
	}
	return inFlight;
}

/**
 * Applies an enriched song to the cached first page, so a view restored from
 * the cache shows resolved titles/credits without re-running the prefetch.
 * Continuation pages are not cached; updates for their songs are no-ops.
 */
export function patchCachedHomeFeedSong(updated: Song) {
	if (!entry) return;
	entry.sections = withUpdatedSong(entry.sections, updated);
}

async function loadHomeFeed(): Promise<HomeFeedSnapshot> {
	const client = await getYoutubeClient();
	const feed = await client.music.getHomeFeed();
	const snapshot: HomeFeedSnapshot = {
		feed,
		sections: homeSectionsFromFeed(feed),
	};
	// An empty first page is treated as a failed load: return it so the view can
	// show its empty state, but do not pin it in the cache for half an hour.
	if (snapshot.sections.length > 0) {
		entry = { ...snapshot, timestamp: Date.now() };
	}
	return snapshot;
}
