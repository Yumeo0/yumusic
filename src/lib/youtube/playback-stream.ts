import { type Innertube, Utils, YT } from "youtubei.js/web";
import { botguardService } from "./botguard-service";
import { getYoutubeClient } from "./client-session";
import type { SongVersion } from "./song-version";
import { getSongVersion } from "./track-meta";

interface PlaybackStream {
	videoId: string;
	videoInfo: YT.VideoInfo;
	innertube: Innertube;
	poToken: string;
	songVersion?: SongVersion;
}

export async function getSongStream(
	videoId: string,
	signal?: AbortSignal,
	background = false,
): Promise<PlaybackStream> {
	signal?.throwIfAborted();
	const client = await getYoutubeClient();
	signal?.throwIfAborted();

	// Both /player and SABR need tokens bound to this video's ID. The native
	// minter also supplies the visitor context used to attest the request.
	const poToken = await botguardService.preparePlayback(
		client,
		videoId,
		signal,
		background,
	);
	signal?.throwIfAborted();

	const playerResponse = await client.actions.execute("/player", {
		videoId,
		contentCheckOk: true,
		racyCheckOk: true,
		playbackContext: {
			contentPlaybackContext: {
				signatureTimestamp: client.session.player?.signature_timestamp,
			},
		},
		serviceIntegrityDimensions: {
			poToken,
		},
	});
	signal?.throwIfAborted();

	const cpn = Utils.generateRandomString(16);
	const info = new YT.VideoInfo([playerResponse], client.actions, cpn);

	return { videoId, videoInfo: info, innertube: client, poToken };
}

/**
 * Stream session for a track, preferring its song version: when YouTube Music
 * pairs a music video with an album track, the track is that song, so
 * playback, crossfade preloading and downloads all use the song's stream.
 * Fetch the original in parallel with the version lookup so tracks without a
 * counterpart can play promptly. A playable counterpart only needs its own
 * response. `videoId` is the actual streamed id.
 */
export async function getPlaybackStream(
	videoId: string,
	signal?: AbortSignal,
	background = false,
): Promise<PlaybackStream> {
	signal?.throwIfAborted();
	const version = getSongVersion(videoId);
	const fallbackController = new AbortController();
	const fallbackSignal = signal
		? AbortSignal.any([signal, fallbackController.signal])
		: fallbackController.signal;
	const fallback = getSongStream(videoId, fallbackSignal, background).then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	try {
		const songVersion = await version;
		signal?.throwIfAborted();
		if (songVersion && songVersion.id !== videoId) {
			try {
				const result = await getSongStream(songVersion.id, signal, background);
				if (result.videoInfo.streaming_data) return { ...result, songVersion };
				console.warn(
					"[YuMusic] song version has no stream, playing the original video",
				);
			} catch (error) {
				signal?.throwIfAborted();
				console.warn(
					"[YuMusic] song version unavailable, playing the original video:",
					error,
				);
			}
		}
		const original = await fallback;
		signal?.throwIfAborted();
		if ("error" in original) throw original.error;
		return original.value;
	} finally {
		fallbackController.abort();
	}
}
