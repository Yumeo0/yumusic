import {
	applySongEnrichment,
	type SongEnrichment,
} from "@/lib/music/song-enrichment";
import { normalizeHomeSectionTitle } from "@/lib/stores/home-sections";
import { getYoutubeClient } from "./client-session";
import {
	type FeedItem,
	feedItemKey,
	type HomeFeed,
	type HomeSection,
	homeSectionsFromFeed,
} from "./feed-items";
import { canonicalPlaylistId } from "./playlist-id";

const HOME_FEED_TTL_MS = 30 * 60 * 1000;
const MAX_HOME_CONTINUATION_PAGES = 10;

interface CacheEntry {
	feed: HomeFeed;
	sections: HomeSection[];
	sectionKeys: Set<string>;
	timestamp: number;
	pages: number;
}

function isFresh(entry: CacheEntry | null): entry is CacheEntry {
	return !!entry && Date.now() - entry.timestamp < HOME_FEED_TTL_MS;
}

function sectionKey(section: HomeSection): string {
	const first = section.items[0];
	return `${normalizeHomeSectionTitle(section.title)}::${first ? feedItemKey(first) : ""}`;
}

function updateItems(
	sections: HomeSection[],
	update: (item: FeedItem) => FeedItem | null,
): HomeSection[] {
	let changed = false;
	const next = sections.map((section) => {
		let sectionChanged = false;
		const items = section.items.flatMap((item) => {
			const updated = update(item);
			sectionChanged ||= updated !== item;
			return updated ? [updated] : [];
		});
		if (!sectionChanged) return section;
		changed = true;
		return { ...section, items };
	});
	return changed ? next : sections;
}

/** Loads all page data independently of scrolling; artwork stays lazy-loaded. */
export class HomeFeedCache {
	private entry: CacheEntry | null = null;
	private inFlight: Promise<HomeSection[]> | null = null;
	private listeners = new Set<(sections: HomeSection[]) => void>();
	private deletedPlaylistIds = new Set<string>();

	constructor(
		private fetchFeed: () => Promise<HomeFeed>,
		private parseFeed = homeSectionsFromFeed,
	) {}

	read(): HomeSection[] | null {
		return isFresh(this.entry) ? this.entry.sections : null;
	}

	subscribe(onUpdate: (sections: HomeSection[]) => void) {
		this.listeners.add(onUpdate);
		return () => {
			this.listeners.delete(onUpdate);
		};
	}

	get(): Promise<HomeSection[]> {
		this.inFlight ??= this.load().finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	patchSong(videoId: string, enrichment: SongEnrichment) {
		if (!this.entry) return;
		const sections = updateItems(this.entry.sections, (item) => {
			if (item.kind !== "song" || item.song.id !== videoId) return item;
			const song = applySongEnrichment(item.song, enrichment);
			return song === item.song ? item : { ...item, song };
		});
		if (sections !== this.entry.sections) this.publish(this.entry, sections);
	}

	removePlaylist(id: string) {
		this.deletedPlaylistIds.add(canonicalPlaylistId(id));
		if (!this.entry) return;
		const sections = this.removeDeletedPlaylists(this.entry.sections);
		if (sections !== this.entry.sections) this.publish(this.entry, sections);
	}

	private removeDeletedPlaylists(sections: HomeSection[]): HomeSection[] {
		if (this.deletedPlaylistIds.size === 0) return sections;
		return updateItems(sections, (item) =>
			(item.kind === "playlist" || item.kind === "album") &&
			this.deletedPlaylistIds.has(canonicalPlaylistId(item.id))
				? null
				: item,
		);
	}

	private publish(entry: CacheEntry, sections: HomeSection[]) {
		entry.sections = sections;
		for (const listener of this.listeners) listener(sections);
	}

	private async load(): Promise<HomeSection[]> {
		let entry = this.entry;
		if (!isFresh(entry)) {
			const feed = await this.fetchFeed();
			const sections = this.parseFeed(feed);
			entry = {
				feed,
				sections: this.removeDeletedPlaylists(sections),
				sectionKeys: new Set(sections.map(sectionKey)),
				timestamp: Date.now(),
				pages: 0,
			};
			this.entry = entry;
			this.publish(entry, entry.sections);
		}
		while (
			entry.feed.has_continuation &&
			entry.pages < MAX_HOME_CONTINUATION_PAGES
		) {
			// Tokens depend on the preceding page. Continue even if the view unmounts.
			const next = await entry.feed.getContinuation();
			const added = this.parseFeed(next).filter((section) => {
				const key = sectionKey(section);
				if (entry.sectionKeys.has(key)) return false;
				entry.sectionKeys.add(key);
				return true;
			});
			entry.feed = next;
			entry.pages++;
			if (added.length > 0)
				this.publish(entry, [
					...entry.sections,
					...this.removeDeletedPlaylists(added),
				]);
		}
		// Empty responses should be retried on the next visit.
		if (entry.sections.length === 0) this.entry = null;
		return entry.sections;
	}
}

const cache = new HomeFeedCache(async () => {
	const client = await getYoutubeClient();
	return client.music.getHomeFeed();
});

export const readCachedHomeFeed = () => cache.read();
export const subscribeToHomeFeed = (
	onUpdate: (sections: HomeSection[]) => void,
) => cache.subscribe(onUpdate);
export const getHomeFeed = () => cache.get();
export const patchCachedHomeFeedSong = (
	videoId: string,
	enrichment: SongEnrichment,
) => cache.patchSong(videoId, enrichment);
export const removeHomeFeedPlaylist = (id: string) => cache.removePlaylist(id);
