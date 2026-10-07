import type { Song } from "@/contexts/player-context";

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

// v11: cached tracks carry the description-resolved artists' channel ids
// (v10 could cache adopted artists without their channel links);
// v10: playlist covers resolve to the largest variant (v9 and earlier could
// cache a tiny custom-cover variant);
// v9: album tracks inherit the header artist (v8 cached "Unknown Artist");
// v8: cached playlists carry a reliable editable flag so own playlists offer
// "Remove from playlist" (v7 could cache a false negative).
export const PLAYLIST_CACHE_PREFIX = "yumusic:playlist:v11:";

/** Plain-data snapshot of a playlist (JSON-safe for persistence). */
export interface PlaylistView {
	/** Route id the snapshot belongs to; absent in pre-v10 caches. */
	id?: string;
	title: string;
	subtitle: string;
	thumbnail: string | null;
	songs: Song[];
	complete: boolean;
	/** The playlist belongs to the user and can be edited. */
	editable: boolean;
}

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
		return;
	} catch {
		// Quota exceeded. Playlist caches are the big consumers, so evict the
		// oldest ones and retry; otherwise the write silently disappears and
		// the playlist refetches on every visit forever.
		for (let attempt = 0; attempt < 3; attempt++) {
			if (!evictOldestPlaylistCache(key)) break;
			try {
				localStorage.setItem(key, payload);
				return;
			} catch {
				// still no room — evict another
			}
		}
		console.warn(`[cache] could not store ${key} (storage full?)`);
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
	const key = PLAYLIST_CACHE_PREFIX + id;
	const cached = readCache<PlaylistView>(key);
	if (!cached) return;
	writeCache(key, { ...cached.data, songs: [song, ...cached.data.songs] });
}

/** Drops a deleted playlist from the library list and its track cache. */
export function removePlaylistFromCaches(id: string) {
	const cached = readCache<Array<{ id: string }>>(LIBRARY_CACHE_KEY);
	if (cached) {
		writeCache(
			LIBRARY_CACHE_KEY,
			cached.data.filter((playlist) => playlist.id !== id),
		);
	}
	try {
		localStorage.removeItem(PLAYLIST_CACHE_PREFIX + id);
	} catch {
		// best-effort
	}
}

/**
 * Replaces cached songs matched by video id, e.g. after a description has
 * resolved a track's title/artist. Playlists without a cache entry are left
 * alone — there is nothing to patch.
 */
export function patchCachedPlaylistSongs(
	id: string,
	updates: ReadonlyMap<string, Song>,
) {
	if (updates.size === 0) return;
	const key = PLAYLIST_CACHE_PREFIX + id;
	const cached = readCache<PlaylistView>(key);
	if (!cached) return;
	writeCache(key, {
		...cached.data,
		songs: cached.data.songs.map((song) => updates.get(song.id) ?? song),
	});
}

const LIBRARY_CHANGED_EVENT = "yumusic:library-changed";

/** Drops the cached library list so mounted and future views refetch it. */
export function invalidateLibraryCache() {
	try {
		localStorage.removeItem(LIBRARY_CACHE_KEY);
	} catch {
		// best-effort
	}
	window.dispatchEvent(new Event(LIBRARY_CHANGED_EVENT));
}

/** Subscribes to library invalidations; returns the unsubscribe function. */
export function subscribeToLibraryChanges(listener: () => void): () => void {
	window.addEventListener(LIBRARY_CHANGED_EVENT, listener);
	return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, listener);
}

/** Tracks from a playlist-page visit less than a sync interval ago. */
export function readCachedPlaylistSongs(id: string): Song[] | null {
	const cached = readCache<PlaylistView>(PLAYLIST_CACHE_PREFIX + id);
	if (!cached || cached.data.songs.length === 0) return null;
	if (Date.now() - cached.timestamp >= SYNC_INTERVAL_MS) return null;
	return cached.data.songs;
}

/**
 * Replaces the stored tracklist after a fresh fetch, keeping the cached
 * metadata (title, editable flag, …) intact. Playlists never visited are
 * left alone — there is no metadata to keep.
 */
export function refreshCachedPlaylistSongs(id: string, songs: Song[]) {
	const key = PLAYLIST_CACHE_PREFIX + id;
	const cached = readCache<PlaylistView>(key);
	if (!cached) return;
	writeCache(key, { ...cached.data, songs, complete: true });
}
