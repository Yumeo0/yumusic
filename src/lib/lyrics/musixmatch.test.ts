import { describe, expect, test } from "bun:test";
import { fetchMusixmatchSynced, parseRichsync } from "./musixmatch";

describe("parseRichsync", () => {
	test("keeps per-word timings on each line", () => {
		const body = JSON.stringify([
			{
				ts: "12.5",
				l: [
					{ c: "We're", o: 0 },
					{ c: " no", o: 0.5 },
					{ c: " strangers", o: 0.9 },
				],
			},
			{
				ts: "15.2",
				l: [
					{ c: "to", o: 0 },
					{ c: " love", o: 0.4 },
				],
			},
		]);
		const lines = parseRichsync(body);
		expect(lines).toHaveLength(2);
		expect(lines[0].text).toBe("We're no strangers");
		expect(lines[0].words?.map((word) => word.time)).toEqual([12.5, 13, 13.4]);
		expect(lines[1].words?.[1].text).toBe(" love");
		expect(lines[1].words?.[1].time).toBeCloseTo(15.6);
	});

	test("lines without words still parse", () => {
		const body = JSON.stringify([{ ts: "3.5", l: [] }]);
		const lines = parseRichsync(body);
		expect(lines).toHaveLength(0);
	});

	test("malformed payloads resolve to an empty list", () => {
		expect(parseRichsync("not json")).toEqual([]);
		expect(parseRichsync("{}")).toEqual([]);
	});
});

test("falls back to classic LRC with timing offsets and no blank lines", async () => {
	const originalFetch = globalThis.fetch;
	const fetchFixture = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname.endsWith("/token.get"))
			return Response.json({ message: { body: { user_token: "fixture" } } });
		if (!url.pathname.endsWith("/macro.subtitles.get"))
			throw new Error(`Unexpected request to ${url.pathname}`);

		return Response.json({
			message: {
				body: {
					macro_calls: {
						"matcher.track.get": {
							message: {
								header: { status_code: 200 },
								body: { track: { track_name: "Song", artist_name: "Artist" } },
							},
						},
						"track.subtitles.get": {
							message: {
								body: {
									subtitle_list: [
										{
											subtitle: {
												subtitle_body:
													"[offset:+500]\n[00:01]\n[00:02.5] Hello",
											},
										},
									],
								},
							},
						},
					},
				},
			},
		});
	};
	globalThis.fetch = Object.assign(fetchFixture, {
		preconnect: originalFetch.preconnect,
	});
	try {
		expect(await fetchMusixmatchSynced("Song", "Artist")).toEqual([
			{ time: 2, text: "Hello" },
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
