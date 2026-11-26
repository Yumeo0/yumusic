import type { Song } from "./song";

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

export interface LibraryPlaylist {
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string | null;
}
