import type { Song } from "./song";

export interface PlaylistTrack extends Song {
	/** YouTube's identity for one occurrence of a video in an editable playlist. */
	entryId?: string;
}

export interface PlaylistView {
	/** Route id the snapshot belongs to; absent in pre-v10 caches. */
	id?: string;
	title: string;
	subtitle: string;
	thumbnail: string | null;
	songs: PlaylistTrack[];
	complete: boolean;
	/** The playlist belongs to the user and can be edited. */
	editable: boolean;
}

export interface LibraryPlaylist {
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string | null;
}
