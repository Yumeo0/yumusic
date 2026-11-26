import type { Innertube, YT } from "youtubei.js/web";
import { createSabrAudioSource } from "../youtube/sabr-source";
import { mountBufferedAudio } from "./media-buffer";
import { nativeAudio } from "./native-audio";

export async function mountSabrAudio(
	media: HTMLMediaElement,
	videoInfo: YT.VideoInfo,
	innertube: Innertube,
	options: { signal: AbortSignal; onReady: () => void; autoPlay?: boolean },
) {
	const createSession = await createSabrAudioSource(
		videoInfo.basic_info.id,
		videoInfo,
		innertube,
		options.signal,
	);
	const streamOptions = {
		...options,
		duration: videoInfo.basic_info.duration ?? 0,
	};
	const native = nativeAudio(media);
	if (native) await native.mountStream(createSession, streamOptions);
	else await mountBufferedAudio(media, createSession, streamOptions);
}
