/**
 * YouTube Music's "song version" of a music video. When a video has an
 * album-track equivalent, YouTube Music's UI offers to switch to it, and the
 * Up Next queue reports the pair by wrapping the played entry and its
 * counterpart in a PlaylistPanelVideoWrapper — this is where the song
 * version's id and listing metadata can be read from.
 */
import type { Song } from "@/contexts/player-context";

/** The queue-entry fields needed from a PlaylistPanelVideo. */
export interface QueueEntry {
	video_id: string;
	endpoint?: {
		payload?: {
			watchEndpointMusicSupportedConfigs?: {
				watchEndpointMusicConfig?: { musicVideoType?: string };
			};
		};
	};
}

/** The wrapper fields needed from a PlaylistPanelVideoWrapper. */
export interface QueueWrapper<T extends QueueEntry = QueueEntry> {
	primary: T | null;
	counterpart?: T[];
}

/** The album-track version of a video, with the metadata to adopt. */
export interface SongVersion {
	id: string;
	title?: string;
	artists?: Array<{ name: string; id?: string }>;
	duration?: string;
	thumbnail?: string;
	album?: { name: string; id?: string };
}

/** The queue entry's music video type, e.g. "MUSIC_VIDEO_TYPE_ATV". */
export function musicVideoTypeOf(entry: QueueEntry): string | undefined {
	return entry.endpoint?.payload?.watchEndpointMusicSupportedConfigs
		?.watchEndpointMusicConfig?.musicVideoType;
}

/**
 * The song version's queue entry for `videoId`, or null when the queue offers
 * none. Only an album-track ("ATV") counterpart of a video entry counts:
 * playing the album track itself is never redirected to its video
 * counterpart, and wrappers of other queue entries are ignored.
 */
export function songVersionEntryFromQueue<T extends QueueEntry>(
	wrappers: QueueWrapper<T>[],
	videoId: string,
): T | null {
	for (const wrapper of wrappers) {
		const primary = wrapper.primary;
		if (!primary || primary.video_id !== videoId) continue;
		// Already the album track — there is nothing to switch to.
		if (musicVideoTypeOf(primary) === "MUSIC_VIDEO_TYPE_ATV") continue;
		for (const counterpart of wrapper.counterpart ?? []) {
			if (counterpart.video_id === videoId) continue;
			if (musicVideoTypeOf(counterpart) === "MUSIC_VIDEO_TYPE_ATV") {
				return counterpart;
			}
		}
	}
	return null;
}

/**
 * `song` as its song version: id, title, credits, artwork and length come
 * from the album track, and video-only state (the uploader description)
 * is dropped — the album track carries its own release metadata.
 */
export function applySongVersion(song: Song, version: SongVersion): Song {
	const artists = version.artists?.length ? version.artists : undefined;
	return {
		...song,
		id: version.id,
		title: version.title ?? song.title,
		artist: artists
			? artists.map((artist) => artist.name).join(", ")
			: song.artist,
		artistId: artists ? artists.find((artist) => artist.id)?.id : song.artistId,
		artists: artists ?? song.artists,
		thumbnail: version.thumbnail ?? song.thumbnail,
		duration: version.duration ?? song.duration,
		description: undefined,
		upload: undefined,
	};
}
