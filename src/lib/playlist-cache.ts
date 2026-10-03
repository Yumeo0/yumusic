/**
 * Auto-sync policy: fetch on first use, persist to localStorage, then only
 * re-sync after 24h — or when the user hits the refresh button.
 */
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

// v6: the library is fetched in English; v5 and earlier could hold a locally
// localized (e.g. Japanese) auto-playlist name.
export const LIBRARY_CACHE_KEY = "yumusic:library:v6";

// v8: cached playlists carry a reliable editable flag so own playlists offer
// "Remove from playlist" (v7 could cache a false negative).
export const PLAYLIST_CACHE_PREFIX = "yumusic:playlist:v8:";

/** Drops a playlist's cached tracklist, e.g. after adding/removing a song. */
export function clearPlaylistCache(id: string) {
	try {
		localStorage.removeItem(PLAYLIST_CACHE_PREFIX + id);
	} catch {
		// best-effort
	}
}
