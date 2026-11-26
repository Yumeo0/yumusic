import { getDownloadEntry } from "@/lib/downloads/downloads";
import type { Song } from "@/lib/music/song";
import { rememberSongVersion } from "@/lib/stores/song-versions";
import { applySongDescription } from "@/lib/utils/description";
import { rememberSongDescription } from "@/lib/youtube/song-description";
import { applySongVersion } from "@/lib/youtube/song-version";
import { isVideoId } from "@/lib/youtube/youtube.utils";
import {
	getPlaybackStream,
	getSongStream,
	getSongVersion,
} from "@/lib/youtube/youtube-client";

export function findDownloadedTrack(song: Song) {
	const entry = getDownloadEntry(song.id);
	return entry
		? {
				entry,
				song: entry.description
					? applySongDescription(song, entry.description)
					: song,
			}
		: null;
}

export async function resolveStreamTrack(
	song: Song,
	{ exact = false, isCurrent }: { exact?: boolean; isCurrent: () => boolean },
) {
	if (!isVideoId(song.id))
		throw new Error(`Invalid video id "${song.id}" for "${song.title}"`);
	const ensureCurrent = () => {
		if (!isCurrent()) throw new DOMException("Playback changed", "AbortError");
	};
	const stream = exact
		? { ...(await getSongStream(song.id)), videoId: song.id }
		: await getPlaybackStream(song.id);
	ensureCurrent();
	if (exact && !stream.videoInfo.streaming_data)
		throw new Error("This track is unavailable on this device.");
	if (stream.videoId !== song.id) {
		const version = await getSongVersion(song.id);
		ensureCurrent();
		if (version) {
			const played = applySongVersion(song, version);
			rememberSongVersion(song, played);
			song = played;
		}
	}
	const description = stream.videoInfo.basic_info.short_description?.trim();
	if (description) {
		rememberSongDescription(song.id, description);
		song = applySongDescription(song, description);
	}
	return { stream, song, description };
}
