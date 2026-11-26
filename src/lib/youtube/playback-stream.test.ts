import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { type Innertube, YTNodes } from "youtubei.js/web";
import { botguardService } from "./botguard-service";
import * as session from "./client-session";
import * as oembed from "./oembed";
import { getPlaybackStream, getSongStream } from "./playback-stream";
import { getSongVersion, getTrackMeta } from "./track-meta";

afterEach(() => mock.restore());

function playerResponse(id: string, playable = true) {
	return {
		success: true,
		status_code: 200,
		data: {
			streamingData: playable
				? {
						serverAbrStreamingUrl: "https://rr1.googlevideo.com/videoplayback",
						adaptiveFormats: [],
					}
				: undefined,
			videoDetails: { videoId: id },
		},
	};
}

function stubPlayback(
	versionId?: string,
	requestTrack = async (id: string) => playerResponse(id),
) {
	const getUpNext = mock(async (id: string) => {
		const video = {
			video_id: id,
			is: (node: unknown) => node === YTNodes.PlaylistPanelVideo,
		};
		const entry = versionId
			? {
					primary: video,
					counterpart: [
						{
							video_id: versionId,
							endpoint: {
								payload: {
									watchEndpointMusicSupportedConfigs: {
										watchEndpointMusicConfig: {
											musicVideoType: "MUSIC_VIDEO_TYPE_ATV",
										},
									},
								},
							},
						},
					],
					is: (node: unknown) => node === YTNodes.PlaylistPanelVideoWrapper,
				}
			: video;
		return { contents: [entry] };
	});
	const execute = mock((_: string, { videoId }: { videoId: string }) =>
		requestTrack(videoId),
	);
	const client = { music: { getUpNext }, actions: { execute }, session: {} };
	spyOn(session, "getYoutubeClient").mockResolvedValue(
		client as unknown as Innertube,
	);
	const preparePlayback = spyOn(
		botguardService,
		"preparePlayback",
	).mockResolvedValue("test-proof");
	return { getUpNext, execute, preparePlayback };
}

test("song-version lookup shares the queue request and finishes while oEmbed is pending", async () => {
	const { getUpNext } = stubPlayback("album-queue");
	const title = Promise.withResolvers<oembed.OembedMetadata>();
	const getTitle = spyOn(oembed, "getOembedMetadata").mockReturnValue(
		title.promise,
	);
	const metadata = getTrackMeta("video-queue");
	expect(await getSongVersion("video-queue")).toMatchObject({
		id: "album-queue",
	});
	expect(getUpNext).toHaveBeenCalledTimes(1);
	expect(getTitle).toHaveBeenCalledTimes(1);
	title.resolve({ title: "Original title", author: null });
	expect(await metadata).toMatchObject({ originalTitle: "Original title" });
});

test("a playable album version resolves while the original player request is still pending", async () => {
	const original = Promise.withResolvers<ReturnType<typeof playerResponse>>();
	const { execute } = stubPlayback("album-preferred", (id) =>
		id === "video-preferred"
			? original.promise
			: Promise.resolve(playerResponse(id)),
	);
	try {
		const stream = await getPlaybackStream("video-preferred");
		expect(stream.videoId).toBe("album-preferred");
		expect(stream.songVersion?.id).toBe("album-preferred");
		expect(execute.mock.calls.map(([, request]) => request.videoId)).toEqual([
			"video-preferred",
			"album-preferred",
		]);
	} finally {
		original.resolve(playerResponse("video-preferred"));
	}
});

test("an album version without a stream falls back to the original", async () => {
	stubPlayback("album-blocked", async (id) =>
		playerResponse(id, id !== "album-blocked"),
	);
	const stream = await getPlaybackStream("video-fallback");
	expect(stream.videoId).toBe("video-fallback");
	expect(stream.songVersion).toBeUndefined();
});

test("a superseded selection skips the player request when preparation completes", async () => {
	const { execute, preparePlayback } = stubPlayback();
	const preparationStarted = Promise.withResolvers<void>();
	const preparation = Promise.withResolvers<string>();
	preparePlayback.mockImplementation(async () => {
		preparationStarted.resolve();
		return preparation.promise;
	});
	const controller = new AbortController();
	const stream = getSongStream("video-superseded", controller.signal);
	await preparationStarted.promise;
	controller.abort();
	preparation.resolve("test-proof");
	await expect(stream).rejects.toBe(controller.signal.reason);
	expect(execute).not.toHaveBeenCalled();
});
