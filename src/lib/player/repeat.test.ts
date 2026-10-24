import { describe, expect, test } from "bun:test";
import { nextQueueIndex, normalizeRepeatMode } from "./repeat";

describe("repeat playback", () => {
	test("no loop advances within the queue and stops at its end", () => {
		expect(nextQueueIndex(0, 3, "off", true)).toBe(1);
		expect(nextQueueIndex(2, 3, "off", true)).toBeNull();
	});
	test("playlist repeat wraps to the first entry", () => {
		expect(nextQueueIndex(1, 3, "all", true)).toBe(2);
		expect(nextQueueIndex(2, 3, "all", true)).toBe(0);
		expect(nextQueueIndex(2, 3, "all")).toBe(0);
	});
	test("single-song repeat applies to natural endings and permits skips", () => {
		expect(nextQueueIndex(1, 3, "one", true)).toBe(1);
		expect(nextQueueIndex(2, 3, "one", true)).toBe(2);
		expect(nextQueueIndex(1, 3, "one")).toBe(2);
		expect(nextQueueIndex(2, 3, "one")).toBeNull();
	});
	test("a single-entry playlist repeats and an empty queue never advances", () => {
		expect(nextQueueIndex(0, 1, "all", true)).toBe(0);
		for (const mode of ["off", "all", "one"] as const) {
			expect(nextQueueIndex(-1, 0, mode, true)).toBeNull();
		}
	});
	test("missing or invalid saved modes fall back to no loop", () => {
		for (const value of [undefined, null, "invalid", 1, {}]) {
			expect(normalizeRepeatMode(value)).toBe("off");
		}
		expect(normalizeRepeatMode("one")).toBe("one");
		expect(normalizeRepeatMode("all")).toBe("all");
	});
});
