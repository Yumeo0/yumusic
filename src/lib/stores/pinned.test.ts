import { beforeEach, describe, expect, test } from "bun:test";
import { getPinnedPlaylists, reconcilePinnedPlaylists } from "./pinned";

const storage = new Map<string, string>();
/** Change events emitted by the store; counts actual storage writes. */
let dispatched = 0;

/** Minimal browser globals the pinned store touches. */
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

function seedPinned(entries: unknown[]) {
	storage.set("yumusic:pinned", JSON.stringify(entries));
}

const DEAD_COVER = "https://yt3.googleusercontent.com/dead-token=s192";
const LIVE_COVER =
	"https://yt3.googleusercontent.com/live-token=w544-h544-l90-rj";

beforeEach(installBrowserStubs);

describe("reconcilePinnedPlaylists", () => {
	test("heals a stale title and thumbnail from fresh data", () => {
		seedPinned([{ id: "PL1", title: "Old title", thumbnail: DEAD_COVER }]);

		reconcilePinnedPlaylists([
			{ id: "PL1", title: "New title", thumbnail: LIVE_COVER },
		]);

		expect(getPinnedPlaylists()).toEqual([
			{ id: "PL1", title: "New title", thumbnail: LIVE_COVER },
		]);
		expect(dispatched).toBe(1);
	});

	test("keeps the stored thumbnail when fresh data has none", () => {
		seedPinned([{ id: "PL1", title: "Same", thumbnail: DEAD_COVER }]);

		reconcilePinnedPlaylists([{ id: "PL1", title: "Same", thumbnail: null }]);

		expect(getPinnedPlaylists()[0].thumbnail).toBe(DEAD_COVER);
		expect(dispatched).toBe(0);
	});

	test("ignores entries that are not in the fresh list", () => {
		seedPinned([
			{ id: "PL1", title: "Pinned", thumbnail: DEAD_COVER },
			{ id: "PL2", title: "Unrelated", thumbnail: DEAD_COVER },
		]);

		reconcilePinnedPlaylists([
			{ id: "PL1", title: "Pinned", thumbnail: LIVE_COVER },
		]);

		const pinned = getPinnedPlaylists();
		expect(pinned[0].thumbnail).toBe(LIVE_COVER);
		expect(pinned[1].thumbnail).toBe(DEAD_COVER);
	});

	test("does not write when nothing changed", () => {
		seedPinned([{ id: "PL1", title: "Same", thumbnail: LIVE_COVER }]);

		reconcilePinnedPlaylists([
			{ id: "PL1", title: "Same", thumbnail: LIVE_COVER },
		]);

		expect(dispatched).toBe(0);
	});
});
