import { Utils, YT } from "youtubei.js/web";
import { botguardService } from "./botguard-service";
import { getYoutubeClient } from "./client-session";
import { getSongVersion } from "./track-meta";

export async function getSongStream(videoId: string) {
	const client = await getYoutubeClient();

	// Both /player and SABR need tokens bound to this video's ID. The native
	// minter also supplies the visitor context used to attest the request.
	const poToken = await botguardService.preparePlayback(client, videoId);

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

	const cpn = Utils.generateRandomString(16);
	const info = new YT.VideoInfo([playerResponse], client.actions, cpn);

	return { videoInfo: info, innertube: client, poToken };
}

/**
 * Stream session for a track, preferring its song version: when YouTube Music
 * pairs a music video with an album track, the track is that song, so
 * playback, crossfade preloading and downloads all use the song's stream.
 * The video's own stream is fetched in parallel with the version lookup, so
 * tracks without a song version load exactly as before; when one exists, its
 * stream replaces the video's. `videoId` is the id actually streamed — the
 * Sabr session and its PoToken must use it, not the requested one.
 */
export async function getPlaybackStream(videoId: string) {
	const [version, fallback] = await Promise.allSettled([
		getSongVersion(videoId),
		getSongStream(videoId),
	]);
	const songVersion = version.status === "fulfilled" ? version.value : null;
	if (songVersion && songVersion.id !== videoId) {
		try {
			const result = await getSongStream(songVersion.id);
			// An unplayable version (region blocks) has no stream to feed the
			// player, so it must not replace a working video.
			if (result.videoInfo.streaming_data) {
				console.log(
					`[YuMusic] playing the song version ${songVersion.id} (video: ${videoId})`,
				);
				return { ...result, videoId: songVersion.id };
			}
			console.warn(
				"[YuMusic] song version has no stream, playing the original video",
			);
		} catch (error) {
			console.warn(
				"[YuMusic] song version unavailable, playing the original video:",
				error,
			);
		}
	}
	if (fallback.status === "fulfilled") return { ...fallback.value, videoId };
	throw fallback.reason;
}
