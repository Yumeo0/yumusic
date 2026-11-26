import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import { Constants } from "youtubei.js";
import type { Innertube, YT } from "youtubei.js/web";
import {
	type DownloadQuality,
	selectDownloadAudioFormat,
} from "../downloads/download-quality";
import { botguardService } from "./botguard-service";
import { youtubeFetch } from "./youtube-fetch";

export async function createSabrAudioSource(
	videoId: string | undefined,
	videoInfo: YT.VideoInfo,
	innertube: Innertube,
	signal: AbortSignal,
	{
		background = false,
		downloadQuality,
	}: { background?: boolean; downloadQuality?: DownloadQuality } = {},
) {
	signal.throwIfAborted();
	const streaming = videoInfo.streaming_data;
	if (!videoId || !streaming) throw new Error("Streaming data is missing");
	const serverAbrStreamingUrl = await innertube.session.player?.decipher(
		streaming.server_abr_streaming_url,
	);
	signal.throwIfAborted();
	if (!serverAbrStreamingUrl) throw new Error("SABR streaming URL is missing");
	const proof = await botguardService.getPlaybackProof(
		videoId,
		signal,
		background,
	);
	signal.throwIfAborted();
	const client = proof.context.client;
	const config = {
		videoId,
		fetchFunction: ((input, init) =>
			youtubeFetch(input, init, proof)) as typeof fetch,
		serverAbrStreamingUrl,
		poToken: proof.token,
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
	return (startTimeMs = 0) => {
		const stream = new SabrStream(config);
		try {
			const { audioStream, selectedFormats } = stream.start({
				enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
				audioFormat: downloadQuality
					? (formats) => selectDownloadAudioFormat(formats, downloadQuality)
					: undefined,
				audioPreferences: {},
				isPostLiveDvr: false,
				startTimeMs,
			});
			const format = selectedFormats.audioFormat;
			const mime = format?.mimeType;
			if (!mime) throw new Error("SABR audio format is missing");
			return {
				audio: audioStream as ReadableStream<Uint8Array>,
				mime,
				contentLength: format.contentLength ?? 0,
				dispose: () => {
					void stream.abort().catch(() => undefined);
				},
			};
		} catch (error) {
			void stream.abort().catch(() => undefined);
			throw error;
		}
	};
}
