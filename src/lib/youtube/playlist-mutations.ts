import { stopPlaylistDownload } from "../downloads/downloads";
import type { PlaylistTrack } from "../music/playlist";
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
import { removeHomeFeedPlaylist } from "./home-feed-cache";
import {
	addSongToPlaylist,
	createPlaylist,
	deletePlaylist,
	type PlaylistEdit,
	removePlaylistThumbnail,
	removeSongFromPlaylist,
	setPlaylistThumbnail,
	updatePlaylist,
} from "./playlist-api";
import { fetchPlaylistEditMeta } from "./playlist-data";
import { canonicalPlaylistId } from "./playlist-id";

export async function addPlaylistTrack(id: string, song: Song) {
	await editPlaylistTrack(id, song.id, async () => {
		await addSongToPlaylist(id, song.id);
		addSongToCachedPlaylist(id, song);
	});
}

export async function createPlaylistWithTrack(title: string, song: Song) {
	await createPlaylist(title, song.id);
	invalidateLibraryCache();
}

const activeTrackEdits = new Set<string>();

export function hasActivePlaylistTrackEdit(id: string): boolean {
	const prefix = `${canonicalPlaylistId(id)}:`;
	for (const key of activeTrackEdits) {
		if (key.startsWith(prefix)) return true;
	}
	return false;
}

async function editPlaylistTrack(
	id: string,
	videoId: string,
	edit: () => Promise<void>,
) {
	const key = `${canonicalPlaylistId(id)}:${videoId}`;
	// In older snapshots, adding or removing a duplicate renumbers occurrences.
	if (activeTrackEdits.has(key))
		throw new Error("An edit for this track is already in progress.");
	activeTrackEdits.add(key);
	try {
		await edit();
	} finally {
		activeTrackEdits.delete(key);
	}
}

export async function removePlaylistTrack(
	id: string,
	track: PlaylistTrack,
	occurrence: number,
) {
	await editPlaylistTrack(id, track.id, async () => {
		await removeSongFromPlaylist(id, track.id, occurrence, track.entryId);
		removeSongFromCachedPlaylist(id, track, occurrence);
	});
}

export async function deleteLibraryPlaylist(id: string) {
	await deletePlaylist(id);
	stopPlaylistDownload(id);
	unpinPlaylist(id);
	removePlaylistFromCaches(id);
	removeHomeFeedPlaylist(id);
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
		reconcilePinnedPlaylists([{ id, ...metadata }]);
		patchCachedPlaylistMetadata(id, metadata);
	}
}
