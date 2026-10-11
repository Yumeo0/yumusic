import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findRecording, submitListen } from "./listenbrainz";

const store = new Map<string, string>();

/** Minimal localStorage stub for the MBID/artist caches. */
function installLocalStorageStub() {
	store.clear();
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
			},
			removeItem: (key: string) => {
				store.delete(key);
			},
		},
	});
}

const realFetch = globalThis.fetch;
const requests: string[] = [];

/** Serves the handler's JSON body (or its Response) to every MB request. */
function stubMusicBrainz(handler: (url: URL) => unknown) {
	const stub = async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		requests.push(decodeURIComponent(url.pathname + url.search));
		const result = handler(url);
		if (result instanceof Response) return result;
		return new Response(JSON.stringify(result), {
			headers: { "Content-Type": "application/json" },
			status: 200,
		});
	};
	globalThis.fetch = Object.assign(stub, {
		preconnect: () => undefined,
	}) as typeof fetch;
}

beforeEach(() => {
	installLocalStorageStub();
	requests.length = 0;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("findRecording artist resolution", () => {
	test("resolves an aliased artist before searching the recording", async () => {
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) {
				return {
					artists: [
						{
							score: 100,
							name: "沙花叉クロヱ",
							"sort-name": "Sakamata, Chloe",
							aliases: [{ name: "Sakamata Chloe" }],
						},
					],
				};
			}
			return {
				recordings: [
					{
						id: "dce0a347-c29e-46c4-8d84-7ede8745dcd2",
						title: "モードク",
						length: 167900,
						"artist-credit": [
							{
								name: "沙花叉クロヱ",
								artist: {
									id: "d57e1081-75c6-4b6c-89e8-967c763f6829",
									name: "沙花叉クロヱ",
								},
							},
						],
						releases: [{ id: "c62c93d9-0ce0-4370-ba6c-c7aaea4ed6cc" }],
					},
				],
			};
		});

		const mbids = await findRecording("モードク", "Sakamata Chloe", 168);
		expect(mbids?.recording).toBe("dce0a347-c29e-46c4-8d84-7ede8745dcd2");
		expect(mbids?.artists).toEqual(["d57e1081-75c6-4b6c-89e8-967c763f6829"]);
		expect(mbids?.release).toBe("c62c93d9-0ce0-4370-ba6c-c7aaea4ed6cc");
		// The artist search runs first; the recording search uses its name.
		expect(requests).toHaveLength(2);
		expect(requests[0]).toContain("artist?query=Sakamata Chloe");
		expect(requests[1]).toContain(
			'recording?query=recording:"モードク" AND artist:"沙花叉クロヱ"',
		);
	});

	test("falls back to the given artist name when no artist matches", async () => {
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) {
				return { artists: [{ score: 100, name: "Someone Else" }] };
			}
			return { recordings: [] };
		});

		const mbids = await findRecording("モードク", "Nobody At All", 168);
		expect(mbids).toBeNull();
		// The unmatched artist search must not redirect the recording query;
		// after the fielded attempt the unfielded "title artist" fallback runs.
		expect(requests).toHaveLength(3);
		expect(requests[1]).toContain('artist:"Nobody At All"');
		expect(requests[2]).toContain("query=モードク Nobody At All");
	});

	test("a title the catalog doesn't carry finds its recording unfielded", async () => {
		// "❥ バッドエンドメーカー" is stored as "バッドエンドメーカー": the
		// fielded query misses, the unfielded page search finds the cover.
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) {
				return { artists: [{ score: 100, name: "月乃" }] };
			}
			const query = url.searchParams.get("query") ?? "";
			if (query.startsWith("recording:")) return { recordings: [] };
			return {
				recordings: [
					{
						id: "45903c96-d764-4c7f-8db7-ea82b98070e6",
						title: "バッドエンドメーカー",
						length: 195000,
						"artist-credit": [
							{ name: "月乃", artist: { id: "tsukino-id", name: "月乃" } },
						],
						releases: [],
					},
				],
			};
		});

		const mbids = await findRecording("❥ バッドエンドメーカー", "月乃", 195);
		expect(mbids?.recording).toBe("45903c96-d764-4c7f-8db7-ea82b98070e6");
		expect(requests[2]).toContain("query=❥ バッドエンドメーカー 月乃");
	});

	test("an artist that isn't on MusicBrainz matches nothing", async () => {
		// The title search returns the original by another artist; without an
		// artist match nothing may be linked.
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) return { artists: [] };
			return {
				recordings: [
					{
						id: "original-id",
						title: "ときめきちゅるぴかきゅるるらった",
						length: 159000,
						"artist-credit": [
							{
								name: "p-katsu",
								artist: { id: "p-katsu-id", name: "p-katsu" },
							},
						],
						releases: [],
					},
				],
			};
		});

		const mbids = await findRecording(
			"ときめきちゅるぴかきゅるるらった",
			"加猫 のか",
			159,
		);
		expect(mbids).toBeNull();
	});

	test("a busy MusicBrainz is retried on the next lookup", async () => {
		let recordingCalls = 0;
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) {
				return {
					artists: [
						{
							score: 100,
							name: "ナナヲアカリ",
							aliases: [{ name: "NANAOAKARI" }],
						},
					],
				};
			}
			recordingCalls += 1;
			// The lookup and its single retry are busy; later ones get through.
			if (recordingCalls <= 2) return new Response("busy", { status: 503 });
			return {
				recordings: [
					{
						id: "36a03f56-8ef5-47f0-a293-225bd52b40c0",
						title: "キュートフィクション",
						length: 220000,
						"artist-credit": [
							{
								name: "ナナヲアカリ",
								artist: { id: "nanawo-id", name: "ナナヲアカリ" },
							},
						],
						releases: [],
					},
				],
			};
		});

		// The busy attempt must not poison the session: the next call retries.
		expect(
			await findRecording("キュートフィクション", "NANAOAKARI", 221),
		).toBeNull();
		const mbids = await findRecording(
			"キュートフィクション",
			"NANAOAKARI",
			221,
		);
		expect(mbids?.recording).toBe("36a03f56-8ef5-47f0-a293-225bd52b40c0");
	});

	test("matches a name whose words are in a different order", async () => {
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) {
				return {
					artists: [
						{
							score: 100,
							name: "藍月なくる",
							"sort-name": "Aitsuki, Nakuru",
							aliases: [{ name: "Aitsuki Nakuru" }],
						},
					],
				};
			}
			return {
				recordings: [
					{
						id: "f9bef3ac-65d5-46e3-bd46-a2f9d3a6d465",
						title: "ヘヴンリィ",
						length: 194000,
						"artist-credit": [
							{
								name: "藍月なくる",
								artist: {
									id: "439f95cd-0799-4090-b6e3-f2a9fa331fcb",
									name: "藍月なくる",
								},
							},
						],
						releases: [{ id: "05124fd0-88c5-40a8-afba-68325c677756" }],
					},
				],
			};
		});

		const mbids = await findRecording("ヘヴンリィ", "Nakuru Aitsuki", 195);
		expect(mbids?.recording).toBe("f9bef3ac-65d5-46e3-bd46-a2f9d3a6d465");
		expect(requests[1]).toContain('artist:"藍月なくる"');
	});

	test("retries once when the search server reports being busy", async () => {
		let artistCalls = 0;
		stubMusicBrainz((url) => {
			if (url.pathname.endsWith("/artist")) {
				artistCalls += 1;
				if (artistCalls === 1) return new Response("busy", { status: 503 });
				return { artists: [{ score: 100, name: "Ado" }] };
			}
			return {
				recordings: [
					{
						id: "11111111-2222-3333-4444-555555555555",
						title: "唱",
						length: 200000,
						"artist-credit": [
							{ name: "Ado", artist: { id: "ado-id", name: "Ado" } },
						],
						releases: [{ id: "release-id" }],
					},
				],
			};
		});

		const mbids = await findRecording("唱", "Ado", 200);
		expect(mbids?.recording).toBe("11111111-2222-3333-4444-555555555555");
		expect(artistCalls).toBe(2);
	});
});

describe("submitListen", () => {
	/** Captures the next ListenBrainz request body. */
	function stubListenBrainz(): { request: () => unknown } {
		let captured: unknown = null;
		const stub = async (_input: RequestInfo | URL, init?: RequestInit) => {
			captured = JSON.parse(String(init?.body ?? "null"));
			return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
		};
		globalThis.fetch = Object.assign(stub, {
			preconnect: () => undefined,
		}) as typeof fetch;
		return { request: () => captured };
	}

	test("a scrobble is a single listen carrying listened_at", async () => {
		const { request } = stubListenBrainz();
		await submitListen({
			token: "tok",
			trackName: "Victory Over Truth",
			artistName: "Fox Stevenson",
			album: "Songs",
			listenedAt: 1_700_000_000,
		});
		const body = request() as {
			listen_type: string;
			payload: Array<Record<string, unknown>>;
		};
		expect(body.listen_type).toBe("single");
		expect(body.payload[0]).toMatchObject({
			listened_at: 1_700_000_000,
			track_metadata: {
				track_name: "Victory Over Truth",
				artist_name: "Fox Stevenson",
				release_name: "Songs",
			},
		});
	});

	test("playing now submits without listened_at", async () => {
		const { request } = stubListenBrainz();
		await submitListen({
			token: "tok",
			trackName: "Victory Over Truth",
			artistName: "Fox Stevenson",
		});
		const body = request() as {
			listen_type: string;
			payload: Array<Record<string, unknown>>;
		};
		expect(body.listen_type).toBe("playing_now");
		expect(body.payload[0]).not.toHaveProperty("listened_at");
	});
});
