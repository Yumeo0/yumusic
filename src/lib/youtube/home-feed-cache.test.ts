import { describe, expect, test } from "bun:test";
import type { HomeSection } from "./feed-items";
import { HomeFeedCache } from "./home-feed-cache";
import type { HomeFeed } from "./youtube-client";

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
		await cache.get((sections) => updates.push(sections.length));
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
		expect(a.sections).toEqual(b.sections);
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
		expect((await cache.get()).sections).toHaveLength(2);
	});

	test("deduplicates repeated continuation sections", async () => {
		const cache = new HomeFeedCache(
			async () =>
				page([section("First")], async () =>
					page([section("First"), section("Last")]),
				),
			parse,
		);
		expect((await cache.get()).sections).toEqual([
			section("First"),
			section("Last"),
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
