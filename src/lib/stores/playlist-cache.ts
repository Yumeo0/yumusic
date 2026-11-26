import type { Song } from "@/lib/music/song";
import type {
	LibraryPlaylist,
	PlaylistTrack,
	PlaylistView,
} from "../music/playlist";
import {
	applySongEnrichment,
	type SongEnrichment,
} from "../music/song-enrichment";
import { LruCache } from "../utils/lru-cache";
import { canonicalPlaylistId, playlistBrowseId } from "../youtube/playlist-id";

/**
 * Auto-sync policy: fetch on first use, persist to localStorage, then only
 * re-sync after 24h — or when the user hits the refresh button.
 */
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// v7: covers resolve to the largest variant (v6 and earlier could cache one
// of the tiny variants, e.g. a 64px custom playlist cover);
// v6: the library is fetched in English; v5 and earlier could hold a locally
// localized (e.g. Japanese) auto-playlist name.
export const LIBRARY_CACHE_KEY = "yumusic:library:v7";

// v12: clears views cached before like/dislike states were read from the
// playlist response, so the next visit seeds them once (v11 views would only
// learn a row's rating through a hover lookup);
// v11: cached tracks carry the description-resolved artists' channel ids
// (v10 could cache adopted artists without their channel links);
// v10: playlist covers resolve to the largest variant (v9 and earlier could
// cache a tiny custom-cover variant);
// v9: album tracks inherit the header artist (v8 cached "Unknown Artist");
// v8: cached playlists carry a reliable editable flag so own playlists offer
// "Remove from playlist" (v7 could cache a false negative).
export const PLAYLIST_CACHE_PREFIX = "yumusic:playlist:v12:";

export interface CacheEntry<T> {
	timestamp: number;
	data: T;
}

export function readCache<T>(key: string): CacheEntry<T> | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		return JSON.parse(raw) as CacheEntry<T>;
	} catch {
		return null;
	}
}

export function writeCache<T>(key: string, data: T) {
	const payload = JSON.stringify({
		timestamp: Date.now(),
		data,
	} satisfies CacheEntry<T>);
	try {
		localStorage.setItem(key, payload);
		return true;
	} catch {
		// Quota exceeded. Playlist caches are the big consumers, so evict the
		// oldest ones and retry; otherwise the write silently disappears and
		// the playlist refetches on every visit forever.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (!evictOldestPlaylistCache(key)) break;
			try {
				localStorage.setItem(key, payload);
				return true;
			} catch {
				// still no room — evict another
			}
		}
		console.warn(`[cache] could not store ${key} (storage full?)`);
		return false;
	}
}

/** Removes the least recently written playlist cache (except `keep`). */
function evictOldestPlaylistCache(keep: string): boolean {
	const candidates: Array<{ key: string; timestamp: number }> = [];
	try {
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key?.startsWith(PLAYLIST_CACHE_PREFIX) || key === keep) continue;
			const cached = readCache<unknown>(key);
			candidates.push({ key, timestamp: cached?.timestamp ?? 0 });
		}
		if (candidates.length === 0) return false;
		candidates.sort((a, b) => a.timestamp - b.timestamp);
		localStorage.removeItem(candidates[0].key);
		return true;
	} catch {
		return false;
	}
}

/**
 * Drops caches written by older app versions. Version bumps change the key
 * prefix, so without this every upgrade leaves its old playlist libraries in
 * localStorage, slowly filling the quota until new writes fail.
 */
export function pruneStaleCacheVersions() {
	try {
		const stale: string[] = [];
		for (let index = 0; index < localStorage.length; index++) {
			const key = localStorage.key(index);
			if (!key) continue;
			if (
				key.startsWith("yumusic:playlist:") &&
				!key.startsWith(PLAYLIST_CACHE_PREFIX)
			) {
				stale.push(key);
			} else if (
				key.startsWith("yumusic:library:") &&
				key !== LIBRARY_CACHE_KEY
			) {
				stale.push(key);
			}
		}
		for (const key of stale) localStorage.removeItem(key);
	} catch {
		// best-effort
	}
}

/**
 * Prepends a just-added song to a cached playlist so the next visit shows it
 * without a refetch. Additions land at the top (YouTube Music serves
 * playlists newest-first). A playlist that was never cached is left alone —
 * its first fetch already carries the song.
 */
export function addSongToCachedPlaylist(id: string, song: Song) {
	const cached = readPlaylistView(id);
	if (cached)
		writePlaylistView(id, {
			...cached.data,
			songs: [song, ...cached.data.songs],
		});
	emitPlaylistChange({ id, type: "add", song });
}

const playlistKeys = (id: string) => [
	PLAYLIST_CACHE_PREFIX + canonicalPlaylistId(id),
	PLAYLIST_CACHE_PREFIX + playlistBrowseId(id),
];

const warmPlaylistViews = new LruCache<
	string,
	CacheEntry<PlaylistView> & { libraryRevision: number; revision: number }
>(12);

/** First-render snapshots from this session, invalidated by account/library changes and edits. */
export function readWarmPlaylistView(id: string) {
	const cached = warmPlaylistViews.get(canonicalPlaylistId(id));
	return cached?.libraryRevision === getLibraryRevision() &&
		cached.revision === playlistRevision(id)
		? cached
		: null;
}

export function readPlaylistView(id: string) {
	const [key, alias] = playlistKeys(id);
	const saved = readCache<PlaylistView>(key);
	const legacy = readCache<PlaylistView>(alias);
	if (!saved) return legacy;
	if (!legacy) return saved;
	if (saved.data.complete !== legacy.data.complete)
		return saved.data.complete ? saved : legacy;
	return saved.timestamp >= legacy.timestamp ? saved : legacy;
}

export function writePlaylistView(
	id: string,
	view: PlaylistView,
	{ keepComplete = false } = {},
) {
	if (keepComplete && !view.complete && readPlaylistView(id)?.data.complete)
		return;
	const [key, alias] = playlistKeys(id);
	const canonicalId = canonicalPlaylistId(id);
	const data = { ...view, id: canonicalId };
	if (writeCache(key, data)) {
		warmPlaylistViews.set(canonicalId, {
			data,
			timestamp: Date.now(),
			libraryRevision: getLibraryRevision(),
			revision: playlistRevision(id),
		});
		try {
			localStorage.removeItem(alias);
		} catch {
			// Current entries remain readable even when an old alias cannot be removed.
		}
	}
}

export function readLibraryCache() {
	const cached = readCache<LibraryPlaylist[]>(LIBRARY_CACHE_KEY);
	return cached &&
		Array.isArray(cached.data) &&
		Number.isFinite(cached.timestamp)
		? cached
		: null;
}
export function writeLibraryCache(entries: LibraryPlaylist[]) {
	writeCache(LIBRARY_CACHE_KEY, entries);
}

const PLAYLIST_CHANGED_EVENT = "yumusic:playlist-changed";
export type PlaylistChange = { id: string } & (
	| { type: "add"; song: Song }
	| { type: "remove"; track: PlaylistTrack; occurrence: number }
	| { type: "delete" }
	| { type: "metadata"; patch: Pick<PlaylistView, "title" | "thumbnail"> }
);
const revisions = new Map<string, number>();
export const playlistRevision = (id: string) =>
	revisions.get(canonicalPlaylistId(id)) ?? 0;
function emitPlaylistChange(change: PlaylistChange) {
	revisions.set(
		canonicalPlaylistId(change.id),
		playlistRevision(change.id) + 1,
	);
	window.dispatchEvent(
		new CustomEvent(PLAYLIST_CHANGED_EVENT, { detail: change }),
	);
}
export function subscribeToPlaylistChanges(
	id: string,
	listener: (change: PlaylistChange) => void,
) {
	const receive = (event: Event) => {
		const change = (event as CustomEvent<PlaylistChange>).detail;
		if (canonicalPlaylistId(change.id) === canonicalPlaylistId(id))
			listener(change);
	};
	window.addEventListener(PLAYLIST_CHANGED_EVENT, receive);
	return () => window.removeEventListener(PLAYLIST_CHANGED_EVENT, receive);
}

export function applyPlaylistChange(
	view: PlaylistView,
	change: Exclude<PlaylistChange, { type: "delete" }>,
): PlaylistView {
	switch (change.type) {
		case "metadata":
			return { ...view, ...change.patch };
		case "add":
			return { ...view, songs: [change.song, ...view.songs] };
		case "remove": {
			const { track } = change;
			let occurrence = change.occurrence;
			let fallback = -1;
			const matched = view.songs.findIndex((song, index) => {
				if (song.id !== track.id) return false;
				if (occurrence-- === 0 && (!track.entryId || !song.entryId))
					fallback = index;
				return !!track.entryId && song.entryId === track.entryId;
			});
			const index = matched < 0 ? fallback : matched;
			return index < 0
				? view
				: { ...view, songs: view.songs.filter((_, i) => i !== index) };
		}
	}
}

export function removeSongFromCachedPlaylist(
	id: string,
	track: PlaylistTrack,
	occurrence: number,
) {
	const change = { id, type: "remove", track, occurrence } as const;
	const cached = readPlaylistView(id);
	if (cached) writePlaylistView(id, applyPlaylistChange(cached.data, change));
	emitPlaylistChange(change);
}

/** Apply the confirmed edit directly; an immediate browse can still be stale. */
export function patchCachedPlaylistMetadata(
	id: string,
	patch: Pick<PlaylistView, "title" | "thumbnail">,
) {
	const cached = readPlaylistView(id);
	if (cached) writePlaylistView(id, { ...cached.data, ...patch });
	const library = readLibraryCache();
	if (library)
		writeLibraryCache(
			library.data.map((item) =>
				canonicalPlaylistId(item.id) === canonicalPlaylistId(id)
					? { ...item, ...patch }
					: item,
			),
		);
	emitPlaylistChange({ id, type: "metadata", patch });
	emitLibraryChange();
}

/** Drops a deleted playlist from the library list and its track cache. */
export function removePlaylistFromCaches(id: string) {
	const canonicalId = canonicalPlaylistId(id);
	const cached = readLibraryCache();
	if (cached)
		writeLibraryCache(
			cached.data.filter(
				(playlist) => canonicalPlaylistId(playlist.id) !== canonicalId,
			),
		);
	for (const key of playlistKeys(id)) {
		try {
			localStorage.removeItem(key);
		} catch {
			// best-effort
		}
	}
	emitPlaylistChange({ id, type: "delete" });
	emitLibraryChange();
}

/**
 * Replaces cached songs matched by video id, e.g. after a description has
 * resolved a track's title/artist. Playlists without a cache entry are left
 * alone — there is nothing to patch.
 */
export function patchCachedPlaylistSongs(
	id: string,
	updates: ReadonlyMap<string, SongEnrichment>,
) {
	if (updates.size === 0) return;
	const cached = readPlaylistView(id);
	if (!cached) return;
	writePlaylistView(id, {
		...cached.data,
		songs: cached.data.songs.map((song) => {
			const update = updates.get(song.id);
			return update ? applySongEnrichment(song, update) : song;
		}),
	});
}

const LIBRARY_CHANGED_EVENT = "yumusic:library-changed";
let libraryRevision = 0;

export const getLibraryRevision = () => libraryRevision;

function emitLibraryChange() {
	libraryRevision++;
	window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
}

/** Drops the cached library list so mounted and future views refetch it. */
export function invalidateLibraryCache() {
	try {
		localStorage.removeItem(LIBRARY_CACHE_KEY);
	} catch {
		// best-effort
	}
	emitLibraryChange();
}

/** Subscribes to library invalidations; returns the unsubscribe function. */
export function subscribeToLibraryChanges(listener: () => void): () => void {
	window.addEventListener(LIBRARY_CHANGED_EVENT, listener);
	return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, listener);
}

export function readFreshPlaylistView(id: string) {
	const cached = readPlaylistView(id);
	return isFreshPlaylistView(cached) ? cached.data : null;
}

export function isFreshPlaylistView(
	cached: CacheEntry<PlaylistView> | null,
): cached is CacheEntry<PlaylistView> {
	return (
		!!cached?.data.complete && Date.now() - cached.timestamp < SYNC_INTERVAL_MS
	);
}
