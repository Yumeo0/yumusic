import { describe, expect, test } from "bun:test";
import { shuffleFrom } from "./shuffle";

describe("shuffleFrom", () => {
	test("keeps everything before the start index in place", () => {
		const songs = ["a", "b", "c", "d", "e", "f", "g", "h"];
		for (let i = 0; i < 20; i++) {
			const shuffled = shuffleFrom(songs, 3);
			expect(shuffled.slice(0, 3)).toEqual(["a", "b", "c"]);
			expect([...shuffled.slice(3)].sort()).toEqual(["d", "e", "f", "g", "h"]);
		}
	});

	test("shuffles the whole array when the start index is 0", () => {
		const songs = ["a", "b", "c", "d", "e"];
		const shuffled = shuffleFrom(songs, 0);
		expect([...shuffled].sort()).toEqual(["a", "b", "c", "d", "e"]);
		// The input must not be mutated: the queue state relies on a copy.
		expect(songs).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("returns the same array when there is nothing to shuffle", () => {
		const songs = ["a", "b", "c", "d"];
		expect(shuffleFrom(songs, 4)).toBe(songs);
		expect(shuffleFrom(songs, 3)).toBe(songs);
		expect(shuffleFrom(songs, 10)).toBe(songs);
		expect(shuffleFrom([], 0)).toEqual([]);
	});

	test("clamps a negative start index to the beginning", () => {
		const songs = ["a", "b", "c"];
		const shuffled = shuffleFrom(songs, -1);
		expect([...shuffled].sort()).toEqual(["a", "b", "c"]);
	});
});
