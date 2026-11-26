import { unsubscribeDownloadedPlaylist } from "../downloads/downloads";
import type { Song } from "../music/song";
import { reconcilePinnedPlaylists, unpinPlaylist } from "../stores/pinned";
import {
	addSongToCachedPlaylist,
	invalidateLibraryCache,
	patchCachedPlaylistMetadata,
	removePlaylistFromCaches,
	removeSongFromCachedPlaylist,
} from "../stores/playlist-cache";
import { hiResThumb } from "../utils/utils";
import { fetchPlaylistEditMeta } from "./playlist-data";
import {
	addSongToPlaylist,
	createPlaylist,
	deletePlaylist,
	type PlaylistEdit,
	patchLibraryPlaylist,
	removePlaylistThumbnail,
	removeSongFromPlaylist,
	setPlaylistThumbnail,
	updatePlaylist,
} from "./youtube-client";

export async function addPlaylistTrack(id: string, song: Song) {
	await addSongToPlaylist(id, song.id);
	addSongToCachedPlaylist(id, song);
}

export async function createPlaylistWithTrack(title: string, song: Song) {
	await createPlaylist(title, song.id);
	invalidateLibraryCache();
}

export async function removePlaylistTrack(
	id: string,
	songId: string,
	index: number,
) {
	await removeSongFromPlaylist(id, songId);
	removeSongFromCachedPlaylist(id, songId, index);
}

export async function deleteLibraryPlaylist(id: string) {
	await deletePlaylist(id);
	unsubscribeDownloadedPlaylist(id);
	unpinPlaylist(id);
	removePlaylistFromCaches(id);
}

export async function savePlaylistEdits(
	id: string,
	title: string,
	changes: PlaylistEdit,
	thumbnail: string | null,
	cover?: File | "remove",
) {
	await updatePlaylist(id, changes);
	try {
		if (cover) {
			const url =
				cover === "remove"
					? await removePlaylistThumbnail(id)
					: await setPlaylistThumbnail(
							id,
							new Uint8Array(await cover.arrayBuffer()),
							cover.type || "image/jpeg",
						);
			// A follow-up browse can still return the previous cover.
			thumbnail = url
				? hiResThumb(url, 1080)
				: ((await fetchPlaylistEditMeta(id))?.thumbnail ?? thumbnail);
		}
	} finally {
		const metadata = { title, thumbnail };
		patchLibraryPlaylist(id, metadata);
		reconcilePinnedPlaylists([{ id, ...metadata }]);
		patchCachedPlaylistMetadata(id, metadata);
	}
}
