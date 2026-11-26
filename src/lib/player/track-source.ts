import type { YT } from "youtubei.js/web";
import { getDownloadEntry, hydrateDownloads } from "@/lib/downloads/downloads";
import type { Song } from "@/lib/music/song";
import { rememberSongVersion } from "@/lib/stores/song-versions";
import { applySongDescription } from "@/lib/utils/description";
import { biggestThumb, hiResThumb, parseDuration } from "@/lib/utils/utils";
import {
	getPlaybackStream,
	getSongStream,
} from "@/lib/youtube/playback-stream";
import { createSabrAudioSource } from "@/lib/youtube/sabr-source";
import { rememberSongDescription } from "@/lib/youtube/song-description";
import { applySongVersion } from "@/lib/youtube/song-version";
import { getSongVersion } from "@/lib/youtube/track-meta";
import { isVideoId } from "@/lib/youtube/youtube.utils";
import type { DeckSource, PlaybackDeck } from "./playback-deck";

export interface LoadedTrack {
	song: Song;
	videoInfo?: YT.VideoInfo;
	description?: string;
	artwork?: string;
}

export async function loadTrack(
	deck: PlaybackDeck,
	song: Song,
	options: {
		intent: "play" | "prepare" | "preload";
		isCurrent: () => boolean;
		volume: () => number;
		onPlaybackError: (error: unknown) => void;
	},
): Promise<LoadedTrack> {
	const ensureCurrent = () => {
		if (!options.isCurrent())
			throw new DOMException("Playback changed", "AbortError");
	};
	const mount = { ...options, autoPlay: options.intent === "play" };
	await hydrateDownloads();
	ensureCurrent();
	const entry = getDownloadEntry(song.id);
	if (entry) {
		const source: DeckSource = {
			kind: "file",
			path: entry.path,
			duration: parseDuration(song.duration),
		};
		try {
			await deck.mount(source, mount);
			ensureCurrent();
			return {
				song: entry.description
					? applySongDescription(song, entry.description)
					: song,
				description: entry.description ?? undefined,
				artwork: entry.thumbnail ?? undefined,
			};
		} catch (error) {
			ensureCurrent();
			// Keep the file indexed so kept downloads do not re-download an entire playlist.
			console.warn(
				"[player] Could not play downloaded audio:",
				entry.path,
				error,
			);
		}
	}
	if (!isVideoId(song.id))
		throw new Error(`Invalid video id "${song.id}" for "${song.title}"`);
	const exact = options.intent === "prepare";
	const stream = exact
		? { ...(await getSongStream(song.id)), videoId: song.id }
		: await getPlaybackStream(song.id);
	ensureCurrent();
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
	const { videoInfo, innertube } = stream;
	const info = videoInfo.basic_info;
	const videoId = info.id;
	if (
		!videoId ||
		!videoInfo.streaming_data ||
		info.is_live ||
		info.is_post_live_dvr
	)
		throw new Error("This track is unavailable on this device.");
	const source: DeckSource = {
		kind: "stream",
		duration: info.duration ?? 0,
		open: (signal) =>
			createSabrAudioSource(videoId, videoInfo, innertube, signal),
	};
	await deck.mount(source, mount);
	ensureCurrent();
	const best = biggestThumb(info.thumbnail);
	// Keep the square artwork from music listings when YouTube returns a video thumbnail.
	const artwork =
		best &&
		(/googleusercontent\.com|ggpht\.com/.test(song.thumbnail)
			? hiResThumb(song.thumbnail, 1024)
			: info.category === "Music"
				? hiResThumb(best.url)
				: best.url);
	return { videoInfo, song, description, artwork };
}
