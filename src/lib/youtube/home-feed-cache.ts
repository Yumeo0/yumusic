import type { Song } from "@/contexts/player-context";
import { normalizeHomeSectionTitle } from "@/lib/stores/home-sections";
import type { HomeSection } from "./feed-items";
import {
	feedItemKey,
	homeSectionsFromFeed,
	withUpdatedSong,
} from "./feed-items";
import { getYoutubeClient, type HomeFeed } from "./youtube-client";

export const HOME_FEED_TTL_MS = 30 * 60 * 1000;
/** Guard against an upstream feed that never ends. */
const MAX_HOME_CONTINUATION_PAGES = 10;

export interface HomeFeedSnapshot {
	feed: HomeFeed;
	sections: HomeSection[];
}
interface CacheEntry extends HomeFeedSnapshot {
	timestamp: number;
	pages: number;
}

function isFresh(entry: CacheEntry | null): entry is CacheEntry {
	return !!entry && Date.now() - entry.timestamp < HOME_FEED_TTL_MS;
}

/** Loads all page data independently of scrolling; artwork stays lazy-loaded. */
export class HomeFeedCache {
	private entry: CacheEntry | null = null;
	private inFlight: Promise<HomeFeedSnapshot> | null = null;
	private listeners = new Set<(sections: HomeSection[]) => void>();

	constructor(
		private fetchFeed: () => Promise<HomeFeed>,
		private parseFeed = homeSectionsFromFeed,
	) {}

	read(): HomeSection[] | null {
		return isFresh(this.entry) ? this.entry.sections : null;
	}

	async get(
		onUpdate?: (sections: HomeSection[]) => void,
	): Promise<HomeFeedSnapshot> {
		if (onUpdate) this.listeners.add(onUpdate);
		try {
			if (isFresh(this.entry)) onUpdate?.(this.entry.sections);
			if (!this.inFlight) {
				this.inFlight = this.load().finally(() => {
					this.inFlight = null;
				});
			}
			return await this.inFlight;
		} finally {
			if (onUpdate) this.listeners.delete(onUpdate);
		}
	}

	patchSong(updated: Song) {
		if (!this.entry) return;
		this.entry.sections = withUpdatedSong(this.entry.sections, updated);
	}

	private publish(sections: HomeSection[]) {
		for (const listener of this.listeners) listener(sections);
	}

	private async load(): Promise<HomeFeedSnapshot> {
		let entry = this.entry;
		if (!isFresh(entry)) {
			const feed = await this.fetchFeed();
			entry = {
				feed,
				sections: this.parseFeed(feed),
				timestamp: Date.now(),
				pages: 0,
			};
			this.entry = entry;
			this.publish(entry.sections);
		}
		const sectionKey = (section: HomeSection) =>
			`${normalizeHomeSectionTitle(section.title)}::${
				section.items[0] ? feedItemKey(section.items[0]) : ""
			}`;
		const seen = new Set(entry.sections.map(sectionKey));
		while (
			entry.feed.has_continuation &&
			entry.pages < MAX_HOME_CONTINUATION_PAGES
		) {
			// Tokens depend on the preceding page. Continue even if the view unmounts.
			const next = await entry.feed.getContinuation();
			const sections = this.parseFeed(next).filter((section) => {
				const key = sectionKey(section);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			entry.feed = next;
			entry.pages++;
			entry.sections = [...entry.sections, ...sections];
			this.publish(entry.sections);
		}
		const snapshot = entry;
		// Empty responses should be retried on the next visit.
		if (snapshot.sections.length === 0) this.entry = null;
		return snapshot;
	}
}

const cache = new HomeFeedCache(async () => {
	const client = await getYoutubeClient();
	return client.music.getHomeFeed();
});

export function readCachedHomeFeed(): HomeSection[] | null {
	return cache.read();
}

/** Shared full-feed preload with progressive updates and a 30-minute cache. */
export function getHomeFeed(onUpdate?: (sections: HomeSection[]) => void) {
	return cache.get(onUpdate);
}

export function patchCachedHomeFeedSong(updated: Song) {
	cache.patchSong(updated);
}
