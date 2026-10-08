import { describe, expect, test } from "bun:test";
import type { LrcLine } from "./lrclib";
import { lyricsKind, pickProvider } from "./lyrics-providers";

interface TestLyrics {
	synced: LrcLine[] | null;
	confirmed: boolean;
}

/** A word-synced payload: at least one line carries per-word timings. */
function word(confirmed = true): TestLyrics {
	return {
		synced: [{ time: 0, text: "hi", words: [{ time: 0, text: "hi" }] }],
		confirmed,
	};
}

/** A line-synced payload without word timings. */
function line(confirmed = true): TestLyrics {
	return { synced: [{ time: 0, text: "hi" }], confirmed };
}

function plain(confirmed = true): TestLyrics {
	return { synced: null, confirmed };
}

const ORDER = ["lrclib", "musixmatch", "lrcred"] as const;

describe("lyricsKind", () => {
	test("reads the timing level from the payload", () => {
		expect(lyricsKind(word())).toBe("word");
		expect(lyricsKind(line())).toBe("synced");
		expect(lyricsKind(plain())).toBe("plain");
	});

	test("a single word line makes the payload word-synced", () => {
		expect(
			lyricsKind({
				synced: [
					{ time: 0, text: "hi" },
					{ time: 1, text: "yo", words: [{ time: 1, text: "yo" }] },
				],
			}),
		).toBe("word");
	});
});

describe("pickProvider", () => {
	test("no lyrics resolves to null", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: null, musixmatch: undefined, lrcred: null },
				true,
			),
		).toBeNull();
	});

	test("prefers word sync over line sync regardless of order", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: line(), musixmatch: null, lrcred: word() },
				true,
			),
		).toBe("lrcred");
	});

	test("confirmed word sync beats a higher-priority confirmed line source", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: line(), musixmatch: null, lrcred: word() },
				false,
			),
		).toBe("lrcred");
	});

	test("a confirmed match beats a loose one even across kinds", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: line(), musixmatch: null, lrcred: word(false) },
				true,
			),
		).toBe("lrclib");
	});

	test("among loose matches word sync still wins", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: line(false), musixmatch: null, lrcred: word(false) },
				true,
			),
		).toBe("lrcred");
	});

	test("preferSynced promotes loose timed lyrics over a plain source", () => {
		const sources = { lrclib: plain(), musixmatch: line(false), lrcred: null };
		expect(pickProvider(ORDER, sources, true)).toBe("musixmatch");
		expect(pickProvider(ORDER, sources, false)).toBe("lrclib");
	});

	test("a confirmed timed match still promotes without preferSynced", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: plain(), musixmatch: line(), lrcred: null },
				false,
			),
		).toBe("musixmatch");
	});

	test("plain lyrics keep the priority order", () => {
		expect(
			pickProvider(
				ORDER,
				{ lrclib: plain(), musixmatch: plain(false), lrcred: plain() },
				true,
			),
		).toBe("lrclib");
	});
});
