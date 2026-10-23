import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import { Constants } from "youtubei.js";
import type { Innertube, YT } from "youtubei.js/web";
import { botguardService } from "../youtube/botguard-service";
import { fetchFunction } from "../youtube/youtube-client";
import { mountBufferedAudio } from "./media-buffer";

export async function mountSabrAudio(
	media: HTMLMediaElement,
	videoInfo: YT.VideoInfo,
	innertube: Innertube,
	options: { signal: AbortSignal; onReady: () => void },
) {
	const videoId = videoInfo.basic_info.id;
	const streaming = videoInfo.streaming_data;
	if (!videoId || !streaming) throw new Error("Streaming data is missing");
	const client = innertube.session.context.client;
	const serverAbrStreamingUrl = await innertube.session.player?.decipher(
		streaming.server_abr_streaming_url,
	);
	const poToken = await botguardService.mintToken(videoId);
	options.signal.throwIfAborted();
	if (!serverAbrStreamingUrl) throw new Error("SABR streaming URL is missing");
	const config = {
		videoId,
		fetchFunction: fetchFunction as unknown as typeof fetch,
		serverAbrStreamingUrl,
		poToken,
		videoPlaybackUstreamerConfig:
			videoInfo.player_config?.media_common_config
				.media_ustreamer_request_config?.video_playback_ustreamer_config ?? "",
		clientInfo: {
			osName: client.osName,
			osVersion: client.osVersion,
			clientName: Number.parseInt(
				Constants.CLIENT_NAME_IDS[
					client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
				],
				10,
			),
			clientVersion: client.clientVersion,
		},
		formats: streaming.adaptive_formats.map(buildSabrFormat),
		audioHighWaterMark: 256 * 1024,
		videoHighWaterMark: 0,
	};
	await mountBufferedAudio(
		media,
		(startTimeMs) => {
			const stream = new SabrStream(config);
			try {
				const { audioStream, selectedFormats } = stream.start({
					enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
					audioPreferences: {},
					isPostLiveDvr: false,
					startTimeMs,
				});
				const mime = selectedFormats.audioFormat.mimeType;
				if (!mime) throw new Error("SABR audio format is missing");
				return {
					audio: audioStream as ReadableStream<Uint8Array>,
					mime,
					dispose: () => {
						void stream.abort().catch(() => undefined);
					},
				};
			} catch (error) {
				void stream.abort().catch(() => undefined);
				throw error;
			}
		},
		{ ...options, duration: videoInfo.basic_info.duration ?? 0 },
	);
}
