import { describe, expect, test } from "bun:test";
import { LruCache } from "./lru-cache";

describe("LruCache", () => {
	test("evicts cold entries while keeping recently read entries", () => {
		const cache = new LruCache<string, number>(2);
		cache.set("a", 1).set("b", 2);
		expect(cache.get("a")).toBe(1);
		cache.set("c", 3);
		expect([...cache]).toEqual([
			["a", 1],
			["c", 3],
		]);
	});
	test("replacement does not evict another entry, including undefined values", () => {
		const cache = new LruCache<string, number | undefined>(2);
		cache.set("a", undefined).set("b", 2);
		expect(cache.get("a")).toBeUndefined();
		cache.set("a", 3).set("c", 4);
		expect([...cache]).toEqual([
			["a", 3],
			["c", 4],
		]);
	});
});
