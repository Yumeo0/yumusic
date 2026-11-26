import type { LibraryPlaylist } from "../music/playlist";
import { reconcilePinnedPlaylists } from "../stores/pinned";
import {
	getLibraryRevision,
	readLibraryCache,
	SYNC_INTERVAL_MS,
	writeLibraryCache,
} from "../stores/playlist-cache";
import { fetchLibraryPlaylists } from "./playlist-api";
import { cleanSubtitle } from "./playlist-data";

let pending: { revision: number; result: Promise<LibraryPlaylist[]> } | null =
	null;

export async function loadPlaylistLibrary(
	force = false,
): Promise<LibraryPlaylist[]> {
	const cached = readLibraryCache();
	if (
		!force &&
		cached?.data.length &&
		Date.now() - cached.timestamp < SYNC_INTERVAL_MS
	)
		return cached.data;

	const revision = getLibraryRevision();
	if (pending?.revision === revision) return pending.result;

	const request = { revision, result: refresh() };
	pending = request;
	try {
		return await request.result;
	} finally {
		if (pending === request) pending = null;
	}

	async function refresh() {
		let list: LibraryPlaylist[];
		try {
			list = await fetchLibraryPlaylists();
		} catch (error) {
			if (getLibraryRevision() !== revision) return loadPlaylistLibrary();
			if (cached?.data.length) return cached.data;
			throw error;
		}
		if (getLibraryRevision() !== revision) {
			return readLibraryCache()?.data ?? loadPlaylistLibrary();
		}
		const entries = list.map((item) => ({
			...item,
			subtitle: cleanSubtitle(item.subtitle),
		}));
		// A request made before the login cookie arrives can return an empty library.
		if (entries.length) writeLibraryCache(entries);
		reconcilePinnedPlaylists(entries);
		return entries;
	}
}
