import type { Song } from "@/contexts/player-context";

/**
 * Auto-sync policy: fetch on first use, persist to localStorage, then only
 * re-sync after 24h — or when the user hits the refresh button.
 */
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// v6: the library is fetched in English; v5 and earlier could hold a locally
// localized (e.g. Japanese) auto-playlist name.
export const LIBRARY_CACHE_KEY = "yumusic:library:v6";

// v9: album tracks inherit the header artist (v8 cached "Unknown Artist");
// v8: cached playlists carry a reliable editable flag so own playlists offer
// "Remove from playlist" (v7 could cache a false negative).
export const PLAYLIST_CACHE_PREFIX = "yumusic:playlist:v9:";

/** Plain-data snapshot of a playlist (JSON-safe for persistence). */
export interface PlaylistView {
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
	try {
		localStorage.setItem(
			key,
			JSON.stringify({ timestamp: Date.now(), data } satisfies CacheEntry<T>),
		);
	} catch {
		// quota exceeded — cache is best-effort
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
