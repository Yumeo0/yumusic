import { afterEach, describe, expect, test } from "bun:test";
import { fetchLrcRedLyrics, parseLrcRedSong } from "./lrcred";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

describe("parseLrcRedSong", () => {
	test("word payloads become synced lines with per-word timings", () => {
		const result = parseLrcRedSong({
			level: "word",
			lyrics: {
				lines: [
					{
						begin: 15.21,
						end: 16.0,
						text: "Hello, Hello",
						timed: true,
						words: [
							[
								{ begin: 15.21, end: 15.236, text: "Hel" },
								{ begin: 15.236, end: 15.955, text: "lo," },
							],
							[
								{ begin: 15.955, end: 15.976, text: "Hel" },
								{ begin: 15.976, end: 15.995, text: "lo" },
							],
						],
					},
				],
			},
		});
		expect(result?.plain).toBeNull();
		expect(result?.synced).toEqual([
			{
				time: 15.21,
				text: "Hello, Hello",
				words: [
					{ time: 15.21, end: 15.955, text: "Hello, " },
					{ time: 15.955, end: 15.995, text: "Hello" },
				],
			},
		]);
	});

	test("space-less words keep no separators", () => {
		const result = parseLrcRedSong({
			level: "word",
			lyrics: {
				lines: [
					{
						begin: 19.595,
						end: 20.544,
						text: "愛してるって",
						timed: true,
						words: [
							[{ begin: 19.595, end: 20.1, text: "愛し" }],
							[{ begin: 20.1, end: 20.544, text: "てるって" }],
						],
					},
				],
			},
		});
		expect(result?.synced?.[0].words).toEqual([
			{ time: 19.595, end: 20.1, text: "愛し" },
			{ time: 20.1, end: 20.544, text: "てるって" },
		]);
	});

	test("word chunks without usable timings are dropped", () => {
		const result = parseLrcRedSong({
			level: "word",
			lyrics: {
				lines: [
					{
						begin: 10,
						end: 12,
						text: "hi there",
						timed: true,
						words: [[{ text: "hi" }], [{ text: "there" }]],
					},
				],
			},
		});
		expect(result?.synced).toEqual([{ time: 10, text: "hi there" }]);
	});

	test("line payloads carry timings without words", () => {
		const result = parseLrcRedSong({
			level: "line",
			lyrics: {
				lines: [
					{
						begin: 4.06,
						end: 8.0,
						text: "Is this the real life?",
						timed: false,
						words: [],
					},
					{
						begin: 2.0,
						end: 3.5,
						text: "Out of order line",
						timed: false,
					},
				],
			},
		});
		expect(result?.synced).toEqual([
			{ time: 2, text: "Out of order line" },
			{ time: 4.06, text: "Is this the real life?" },
		]);
	});

	test("untimed payloads become plain text", () => {
		const result = parseLrcRedSong({
			level: "none",
			lyrics: {
				lines: [
					{ begin: 0, end: 0, text: "first line", timed: false, words: [] },
					{ begin: 0, end: 0, text: "second line", timed: false, words: [] },
				],
			},
		});
		expect(result?.synced).toBeNull();
		expect(result?.plain).toBe("first line\nsecond line");
	});

	test("empty payloads are not lyrics", () => {
		expect(parseLrcRedSong({})).toBeNull();
		expect(
			parseLrcRedSong({ level: "line", lyrics: { lines: [] } }),
		).toBeNull();
		expect(
			parseLrcRedSong({
				level: "line",
				lyrics: { lines: [{ begin: 10, end: 12, text: "   " }] },
			}),
		).toBeNull();
	});
});

describe("fetchLrcRedLyrics", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("fetches the best hit's song and keeps word timings", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "QT66L2688451",
							title: "Lieholic (feat. HATSUNE MIKU)",
							artist: "yuugen",
							duration: 172.286,
						},
					],
				});
			}
			return json({
				level: "word",
				lyrics: {
					lines: [
						{
							begin: 19.595,
							end: 20.544,
							text: "愛してるって",
							timed: true,
							words: [[{ begin: 19.595, end: 20.544, text: "愛してるって" }]],
						},
					],
				},
			});
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics(
			"Lieholic (feat. HATSUNE MIKU)",
			"yuugen",
			172,
		);
		expect(result?.confirmed).toBe(true);
		expect(result?.plain).toBeNull();
		expect(result?.synced?.[0].time).toBe(19.595);
		expect(result?.synced?.[0].words).toEqual([
			{ time: 19.595, end: 20.544, text: "愛してるって" },
		]);
		expect(urls).toHaveLength(2);
		expect(new URL(urls[0]).searchParams.get("q")).toBe("Lieholic yuugen");
		expect(urls[1]).toContain("/s/QT66L2688451.song.json");
	});

	test("also searches the translated half of a dual title", async () => {
		const queries: string[] = [];
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/search.json")) {
				const query = new URL(url).searchParams.get("q") ?? "";
				queries.push(query);
				if (query.startsWith("Instinctive Speed")) {
					return json({
						hits: [
							{
								isrc: "EEEE11112222",
								title: "Instinctive Speed",
								artist: "Towa",
								duration: 180,
							},
						],
					});
				}
				return json({ hits: [] });
			}
			if (url.includes(".song.json")) {
				return json({
					level: "line",
					lyrics: {
						lines: [{ begin: 5, end: 7, text: "hi there", timed: false }],
					},
				});
			}
			return json({ sync: "line" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics(
			"本能スピード - Instinctive Speed",
			"Towa",
			180,
		);
		expect(result?.confirmed).toBe(true);
		expect(result?.synced).toEqual([{ time: 5, text: "hi there" }]);
		expect(queries).toHaveLength(2);
		expect(queries).toContain("本能スピード Towa");
		expect(queries).toContain("Instinctive Speed Towa");
	});

	test("plain lyrics are word-aligned on demand", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET" });
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "FFFF11112222",
							title: "Some Song",
							artist: "Some Artist",
							duration: 120,
						},
					],
				});
			}
			if (url.includes("/sync")) {
				return json({
					level: "word",
					lyrics: {
						lines: [
							{
								begin: 1,
								end: 2,
								text: "hi there",
								timed: true,
								words: [[{ begin: 1, end: 2, text: "hi there" }]],
							},
						],
					},
				});
			}
			if (url.includes(".song.json")) {
				return json({
					level: "none",
					lyrics: {
						lines: [{ begin: 0, end: 0, text: "hi there", timed: false }],
					},
				});
			}
			return json({ sync: "none" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 120);
		expect(result?.confirmed).toBe(true);
		expect(result?.plain).toBeNull();
		expect(result?.synced).toEqual([
			{
				time: 1,
				text: "hi there",
				words: [{ time: 1, end: 2, text: "hi there" }],
			},
		]);
		const syncCall = calls.find((call) => call.url.includes("/sync"));
		expect(syncCall?.method).toBe("POST");
	});

	test("a failed sync leaves the plain lyrics in place", async () => {
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "GGGG11112222",
							title: "Some Song",
							artist: "Some Artist",
							duration: 120,
						},
					],
				});
			}
			if (url.includes("/sync")) return json({ error: "busy" }, 503);
			if (url.includes(".song.json")) {
				return json({
					level: "none",
					lyrics: {
						lines: [{ begin: 0, end: 0, text: "plain line", timed: false }],
					},
				});
			}
			return json({ sync: "none" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 120);
		expect(result?.synced).toBeNull();
		expect(result?.plain).toBe("plain line");
	});

	test("line-level lyrics are upgraded to word level on demand", async () => {
		const calls: Array<{ url: string; method: string }> = [];
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET" });
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "HHHH11112222",
							title: "Some Song",
							artist: "Some Artist",
							duration: 120,
						},
					],
				});
			}
			if (url.includes("/sync")) {
				return json({
					level: "word",
					lyrics: {
						lines: [
							{
								begin: 1,
								end: 2,
								text: "hi there",
								timed: true,
								words: [
									[{ begin: 1, end: 1.5, text: "hi" }],
									[{ begin: 1.5, end: 2, text: "there" }],
								],
							},
						],
					},
				});
			}
			if (url.includes(".song.json")) {
				return json({
					level: "line",
					lyrics: {
						lines: [{ begin: 1, end: 2, text: "hi there", timed: false }],
					},
				});
			}
			return json({ sync: "line" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 120);
		expect(result?.plain).toBeNull();
		expect(result?.synced?.[0].words).toEqual([
			{ time: 1, end: 1.5, text: "hi " },
			{ time: 1.5, end: 2, text: "there" },
		]);
		const syncCall = calls.find((call) => call.url.includes("/sync"));
		expect(syncCall?.method).toBe("POST");
	});

	test("line-level lyrics stay as-is when the model cannot improve them", async () => {
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "IIII11112222",
							title: "Some Song",
							artist: "Some Artist",
							duration: 120,
						},
					],
				});
			}
			if (url.includes("/sync")) return json({ error: "nope" }, 422);
			if (url.includes(".song.json")) {
				return json({
					level: "line",
					lyrics: {
						lines: [{ begin: 1, end: 2, text: "hi there", timed: false }],
					},
				});
			}
			return json({ sync: "line" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 120);
		expect(result?.synced).toEqual([{ time: 1, text: "hi there" }]);
	});

	test("bypasses the CDN cache when metadata says a word sync exists", async () => {
		const calls = { search: 0, song: 0, fresh: 0, info: 0 };
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/search.json")) {
				calls.search += 1;
				return json({
					hits: [
						{
							isrc: "AAAA11112222",
							title: "Some Song",
							artist: "Some Artist",
							duration: 120,
						},
					],
				});
			}
			if (url.includes(".song.json")) {
				if (url.includes("?")) {
					calls.fresh += 1;
					return json({
						level: "word",
						lyrics: {
							lines: [
								{
									begin: 1,
									end: 2,
									text: "hi there",
									timed: true,
									words: [
										[{ begin: 1, end: 1.5, text: "hi" }],
										[{ begin: 1.5, end: 2, text: "there" }],
									],
								},
							],
						},
					});
				}
				calls.song += 1;
				return json({
					level: "line",
					lyrics: {
						lines: [{ begin: 1, end: 2, text: "hi there", timed: false }],
					},
				});
			}
			calls.info += 1;
			return json({ sync: "word" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 120);
		expect(calls).toEqual({ search: 1, song: 1, fresh: 1, info: 1 });
		expect(result?.synced?.[0].words).toEqual([
			{ time: 1, end: 1.5, text: "hi " },
			{ time: 1.5, end: 2, text: "there" },
		]);
	});

	test("stale word-level responses are used as-is when metadata agrees", async () => {
		const calls = { song: 0, fresh: 0, info: 0 };
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "CCCC11112222",
							title: "Some Song",
							artist: "Some Artist",
							duration: 120,
						},
					],
				});
			}
			if (url.includes("/sync")) return json({ error: "nope" }, 422);
			if (url.includes(".song.json")) {
				if (url.includes("?")) calls.fresh += 1;
				else calls.song += 1;
				return json({
					level: "line",
					lyrics: {
						lines: [{ begin: 1, end: 2, text: "hi", timed: false }],
					},
				});
			}
			calls.info += 1;
			return json({ sync: "line" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 120);
		expect(calls).toEqual({ song: 1, fresh: 0, info: 1 });
		expect(result?.synced).toEqual([{ time: 1, text: "hi" }]);
	});

	test("title-only matches with a near duration stay unconfirmed", async () => {
		globalThis.fetch = (async (input: unknown) => {
			const url = String(input);
			if (url.includes("/search.json")) {
				return json({
					hits: [
						{
							isrc: "BBBB11112222",
							title: "Some Song",
							artist: "Completely Unrelated",
							duration: 200,
						},
					],
				});
			}
			if (url.includes(".song.json")) {
				return json({
					level: "line",
					lyrics: {
						lines: [{ begin: 3, end: 5, text: "hi", timed: false }],
					},
				});
			}
			return json({ sync: "line" });
		}) as unknown as typeof fetch;

		const result = await fetchLrcRedLyrics("Some Song", "Some Artist", 200);
		expect(result?.confirmed).toBe(false);
		expect(result?.synced).toEqual([{ time: 3, text: "hi" }]);
	});

	test("distant durations do not match", async () => {
		globalThis.fetch = (async () =>
			json({
				hits: [
					{
						isrc: "DDDD11112222",
						title: "Some Song",
						artist: "Some Artist",
						duration: 320,
					},
				],
			})) as unknown as typeof fetch;

		expect(await fetchLrcRedLyrics("Some Song", "Some Artist", 120)).toBeNull();
	});

	test("no hits resolves to null", async () => {
		globalThis.fetch = (async () =>
			json({ hits: [] })) as unknown as typeof fetch;
		expect(await fetchLrcRedLyrics("Some Song", "Some Artist", 120)).toBeNull();
	});
});
