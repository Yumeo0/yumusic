import { expect, spyOn, test } from "bun:test";
import type { PlaybackProof } from "./botguard-service";
import { youtubeFetch } from "./youtube-fetch";

test("a response releases the request timeout and keeps the upstream query intact", async () => {
	const request = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("audio"),
	);
	const start = spyOn(globalThis, "setTimeout");
	const stop = spyOn(globalThis, "clearTimeout");
	try {
		const response = await youtubeFetch(
			"https://rr1.googlevideo.com/videoplayback?sig=a+b%2B~",
		);
		expect(await response.text()).toBe("audio");
		expect(request.mock.calls[0][0]).toContain(
			"?sig=a+b%2B~&__host=rr1.googlevideo.com",
		);
		expect(stop).toHaveBeenCalledWith(start.mock.results[0].value);
	} finally {
		stop.mockRestore();
		start.mockRestore();
		request.mockRestore();
	}
});

test("parallel streams each keep the user agent of their own playback proof", async () => {
	const request = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(async () => new Response("audio"), {
			preconnect: () => undefined,
		}),
	);
	const proof = (userAgent: string) =>
		({ context: { client: { userAgent } } }) as PlaybackProof;
	try {
		await Promise.all([
			youtubeFetch(
				"https://rr1.googlevideo.com/videoplayback",
				undefined,
				proof("first"),
			),
			youtubeFetch(
				"https://rr2.googlevideo.com/videoplayback",
				undefined,
				proof("second"),
			),
		]);
		expect(
			request.mock.calls.map(([, init]) => {
				const proxyHeaders = new Headers(init?.headers).get("X-Proxy-Headers");
				return JSON.parse(proxyHeaders ?? "{}")["User-Agent"];
			}),
		).toEqual(["first", "second"]);
	} finally {
		request.mockRestore();
	}
});
