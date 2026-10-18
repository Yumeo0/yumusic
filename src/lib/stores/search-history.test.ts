import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearRecentSearches,
	forgetSearch,
	getRecentSearches,
	MAX_RECENT_SEARCHES,
	rememberSearch,
} from "./search-history";

const storage = new Map<string, string>();
let dispatched = 0;

/** Minimal browser globals the search-history store touches. */
function installBrowserStubs() {
	storage.clear();
	dispatched = 0;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
			removeItem: (key: string) => {
				storage.delete(key);
			},
		},
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: {
			dispatchEvent: () => {
				dispatched += 1;
				return true;
			},
		},
	});
}

beforeEach(installBrowserStubs);

describe("search history", () => {
	test("keeps the newest query first", () => {
		rememberSearch("one");
		rememberSearch("two");

		expect(getRecentSearches()).toEqual(["two", "one"]);
		expect(dispatched).toBe(2);
	});

	test("moves a repeated query to the top, case-insensitively", () => {
		rememberSearch("Aphex Twin");
		rememberSearch("Boards of Canada");
		rememberSearch("aphex twin");

		expect(getRecentSearches()).toEqual(["aphex twin", "Boards of Canada"]);
	});

	test("trims queries and ignores blanks", () => {
		rememberSearch("  Burial  ");
		rememberSearch("   ");
		rememberSearch("");

		expect(getRecentSearches()).toEqual(["Burial"]);
	});

	test("caps the list at MAX_RECENT_SEARCHES", () => {
		for (let i = 0; i < MAX_RECENT_SEARCHES + 3; i++) {
			rememberSearch(`query ${i}`);
		}

		const searches = getRecentSearches();
		expect(searches).toHaveLength(MAX_RECENT_SEARCHES);
		expect(searches[0]).toBe(`query ${MAX_RECENT_SEARCHES + 2}`);
		expect(searches).not.toContain("query 0");
	});

	test("forgets one query and clears the whole list", () => {
		rememberSearch("one");
		rememberSearch("two");
		forgetSearch("ONE");
		expect(getRecentSearches()).toEqual(["two"]);

		clearRecentSearches();
		expect(getRecentSearches()).toEqual([]);
	});

	test("survives malformed stored data", () => {
		storage.set("yumusic:search-history", "not json");
		expect(getRecentSearches()).toEqual([]);

		storage.set("yumusic:search-history", JSON.stringify([1, "ok", null]));
		expect(getRecentSearches()).toEqual(["ok"]);
	});
});
