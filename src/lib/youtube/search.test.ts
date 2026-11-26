import { expect, mock, spyOn, test } from "bun:test";
import type { Innertube } from "youtubei.js/web";
import * as youtubeSession from "./client-session";
import { getTrackDurations } from "./search";

function mockQueueFetch(fetch: Innertube["session"]["http"]["fetch"]) {
	const client = { session: { http: { fetch } } } as unknown as Innertube;
	return spyOn(youtubeSession, "getYoutubeClient").mockResolvedValue(client);
}

test("duration backfill preserves the music queue request with an abort signal", async () => {
	const fetch = mock(async () =>
		Response.json({
			contents: [
				{
					playlistPanelVideoRenderer: {
						videoId: "ABCDEFGHIJK",
						lengthText: { runs: [{ text: "3:26" }] },
					},
				},
			],
		}),
	);
	const client = mockQueueFetch(fetch);
	const { signal } = new AbortController();
	try {
		const durations = await getTrackDurations(["ABCDEFGHIJK"], signal);
		expect(durations.get("ABCDEFGHIJK")).toBe("3:26");
		expect(fetch).toHaveBeenCalledWith(
			"/music/get_queue",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					videoIds: ["ABCDEFGHIJK"],
					client: "YTMUSIC",
					isAudioOnly: true,
				}),
				signal,
			}),
		);
	} finally {
		client.mockRestore();
	}
});

test("duration backfill drops a response that arrives after cancellation", async () => {
	const response = Promise.withResolvers<Response>();
	const started = Promise.withResolvers<void>();
	const fetch = mock(() => {
		started.resolve();
		return response.promise;
	});
	const client = mockQueueFetch(fetch);
	const controller = new AbortController();
	try {
		const durations = getTrackDurations(["ABCDEFGHIJK"], controller.signal);
		await started.promise;
		controller.abort();
		response.resolve(Response.json({}));
		await expect(durations).rejects.toHaveProperty("name", "AbortError");
	} finally {
		client.mockRestore();
	}
});
