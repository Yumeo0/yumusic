import { beforeEach, describe, expect, test } from "bun:test";
import { pruneStaleCacheVersions, writeCache } from "./playlist-cache";

const store = new Map<string, string>();
/** Simulated localStorage quota, in characters (key + value). */
let limit = Number.POSITIVE_INFINITY;

function usedBytes(): number {
	let total = 0;
	for (const [key, value] of store) total += key.length + value.length;
	return total;
}

/** Minimal localStorage stub with an enforced size limit. */
function installLocalStorageStub() {
	store.clear();
	limit = Number.POSITIVE_INFINITY;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			get length() {
				return store.size;
			},
			key: (index: number) => [...store.keys()][index] ?? null,
			getItem: (key: string) => store.get(key) ?? null,
			removeItem: (key: string) => {
				store.delete(key);
			},
			setItem: (key: string, value: string) => {
				const existing = store.has(key)
					? key.length + (store.get(key)?.length ?? 0)
					: 0;
				if (usedBytes() - existing + key.length + value.length > limit) {
					const error = new Error("QuotaExceededError");
					error.name = "QuotaExceededError";
					throw error;
				}
				store.set(key, value);
			},
		},
	});
}

function seedEntry(key: string, timestamp: number) {
	store.set(key, JSON.stringify({ timestamp, data: {} }));
}

beforeEach(installLocalStorageStub);

describe("writeCache quota recovery", () => {
	test("evicts the oldest playlist cache and stores the new one", () => {
		const targetKey = "yumusic:playlist:v12:target";
		// Measure what one entry of this shape costs, then set the limit so the
		// target can only fit after something is evicted.
		const probeKey = "yumusic:playlist:v12:probe";
		writeCache(probeKey, { payload: "x".repeat(10) });
		const probeBytes = targetKey.length + (store.get(probeKey)?.length ?? 0);
		store.delete(probeKey);

		seedEntry("yumusic:playlist:v12:old", 1);
		seedEntry("yumusic:playlist:v12:newer", 2);
		seedEntry("yumusic:library:v7", 0);
		limit = usedBytes() + probeBytes - 1;

		writeCache(targetKey, { payload: "x".repeat(10) });

		expect(store.has(targetKey)).toBe(true);
		expect(store.has("yumusic:playlist:v12:old")).toBe(false);
		expect(store.has("yumusic:playlist:v12:newer")).toBe(true);
		// The library cache is small and load-bearing; never evicted.
		expect(store.has("yumusic:library:v7")).toBe(true);
	});

	test("gives up quietly when nothing can be evicted", () => {
		limit = 10;
		writeCache("yumusic:playlist:v12:huge", { payload: "x".repeat(100) });
		expect(store.has("yumusic:playlist:v12:huge")).toBe(false);
	});
});

describe("pruneStaleCacheVersions", () => {
	test("drops caches from older versions only", () => {
		seedEntry("yumusic:playlist:v9:abc", 1);
		seedEntry("yumusic:playlist:v12:abc", 1);
		seedEntry("yumusic:library:v6", 1);
		seedEntry("yumusic:library:v7", 1);
		store.set("yumusic:pinned", "[]");

		pruneStaleCacheVersions();

		expect(store.has("yumusic:playlist:v9:abc")).toBe(false);
		expect(store.has("yumusic:playlist:v12:abc")).toBe(true);
		expect(store.has("yumusic:library:v6")).toBe(false);
		expect(store.has("yumusic:library:v7")).toBe(true);
		expect(store.has("yumusic:pinned")).toBe(true);
	});
});
