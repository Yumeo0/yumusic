import { describe, expect, test } from "bun:test";
import type { FeedItem, HomeFeed, HomeSection } from "./feed-items";
import { HomeFeedCache } from "./home-feed-cache";

const section = (title: string): HomeSection => ({
	title,
	items: [{ kind: "navigation", label: title }],
});
function page(
	sections: HomeSection[],
	next?: () => Promise<HomeFeed>,
): HomeFeed {
	return {
		testSections: sections,
		has_continuation: !!next,
		getContinuation: next,
	} as unknown as HomeFeed;
}
const parse = (feed: HomeFeed) =>
	(feed as unknown as { testSections: HomeSection[] }).testSections;

describe("full homepage preload", () => {
	test("loads every page without scrolling, publishes progressively and caches it", async () => {
		let fetches = 0;
		let continuations = 0;
		const last = page([section("Last")]);
		const first = page([section("First")], async () => {
			continuations++;
			return last;
		});
		const cache = new HomeFeedCache(async () => {
			fetches++;
			return first;
		}, parse);
		const updates: number[] = [];
		const unsubscribe = cache.subscribe((sections) =>
			updates.push(sections.length),
		);
		await cache.get();
		unsubscribe();
		expect(updates).toEqual([1, 2]);
		expect(cache.read()?.map((row) => row.title)).toEqual(["First", "Last"]);
		await cache.get();
		expect(fetches).toBe(1);
		expect(continuations).toBe(1);
	});

	test("concurrent visits share the same preload", async () => {
		let fetches = 0;
		let continuations = 0;
		const cache = new HomeFeedCache(async () => {
			fetches++;
			return page([section("First")], async () => {
				continuations++;
				return page([section("Last")]);
			});
		}, parse);
		const [a, b] = await Promise.all([cache.get(), cache.get()]);
		expect(a).toEqual(b);
		expect(fetches).toBe(1);
		expect(continuations).toBe(1);
	});

	test("retains loaded sections after a failure and resumes on the next visit", async () => {
		let attempts = 0;
		const cache = new HomeFeedCache(
			async () =>
				page([section("First")], async () => {
					if (++attempts === 1) throw new Error("Offline");
					return page([section("Last")]);
				}),
			parse,
		);
		await expect(cache.get()).rejects.toThrow("Offline");
		expect(cache.read()).toEqual([section("First")]);
		expect(await cache.get()).toHaveLength(2);
	});

	test("deduplicates repeated continuation sections", async () => {
		const cache = new HomeFeedCache(
			async () =>
				page([section("First")], async () =>
					page([section("First"), section("Last")]),
				),
			parse,
		);
		expect(await cache.get()).toEqual([section("First"), section("Last")]);
	});

	test("removes playlist aliases from cached and incoming shelves after a confirmed deletion", async () => {
		const playlist = (id: string): FeedItem => ({
			kind: "playlist",
			id,
			title: "Deleted",
			subtitle: "",
			thumbnail: "",
		});
		const first = section("First");
		first.items.unshift(playlist("VLPLdeleted"));
		const next = section("Next");
		next.items.unshift(playlist("PLdeleted"));
		const continuation = Promise.withResolvers<HomeFeed>();
		const started = Promise.withResolvers<void>();
		const cache = new HomeFeedCache(
			async () =>
				page([first], () => {
					started.resolve();
					return continuation.promise;
				}),
			parse,
		);
		const updates: HomeSection[][] = [];
		const unsubscribe = cache.subscribe((sections) => updates.push(sections));
		const preload = cache.get();
		await started.promise;
		cache.removePlaylist("PLdeleted");
		expect(cache.read()).toEqual([section("First")]);
		continuation.resolve(page([first, next]));
		expect(await preload).toEqual([section("First"), section("Next")]);
		expect(updates.slice(1)).toEqual([
			[section("First")],
			[section("First"), section("Next")],
		]);
		unsubscribe();
	});

	test("applies a song's enrichment to each occurrence with its own artwork and credits", async () => {
		const id = "abcdefghijk";
		const first: FeedItem = {
			kind: "song",
			song: { id, title: "Some Song", thumbnail: "first", artist: "One" },
		};
		const second: FeedItem = {
			kind: "song",
			song: { id, title: "Some Song", thumbnail: "second", artist: "Two" },
		};
		const cache = new HomeFeedCache(
			async () => page([{ title: "Tracks", items: [first, second] }]),
			parse,
		);
		await cache.get();
		cache.patchSong(id, { upload: true });
		cache.patchSong(id, { description: "Unstructured notes" });
		expect(cache.read()?.[0]?.items).toEqual([
			{
				kind: "song",
				song: {
					...first.song,
					upload: true,
					description: "Unstructured notes",
				},
			},
			{
				kind: "song",
				song: {
					...second.song,
					upload: true,
					description: "Unstructured notes",
				},
			},
		]);
	});

	test("bounds an endlessly continuing upstream feed", async () => {
		let calls = 0;
		const endless = page([section("First")], async () => {
			calls++;
			return endless;
		});
		const cache = new HomeFeedCache(async () => endless, parse);
		await cache.get();
		await cache.get();
		expect(calls).toBe(10);
	});

	test("does not pin an empty response in the cache", async () => {
		let fetches = 0;
		const cache = new HomeFeedCache(async () => {
			fetches++;
			return page([]);
		}, parse);
		await cache.get();
		await cache.get();
		expect(cache.read()).toBeNull();
		expect(fetches).toBe(2);
	});
});
