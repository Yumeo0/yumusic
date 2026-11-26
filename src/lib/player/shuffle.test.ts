import { describe, expect, spyOn, test } from "bun:test";
import { shuffleFrom } from "./shuffle";

describe("shuffleFrom", () => {
	test("shuffles the requested suffix while keeping the prefix and input intact", () => {
		const original = ["a", "b", "c", "d", "e"];
		const random = spyOn(Math, "random").mockReturnValue(0);
		try {
			expect(shuffleFrom(original, 2)).toEqual(["a", "b", "d", "e", "c"]);
			expect(shuffleFrom(original, 0)).toEqual(["b", "c", "d", "e", "a"]);
			expect(original).toEqual(["a", "b", "c", "d", "e"]);
		} finally {
			random.mockRestore();
		}
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
		const random = spyOn(Math, "random").mockReturnValue(0);
		try {
			expect(shuffleFrom(songs, -1)).toEqual(["b", "c", "a"]);
		} finally {
			random.mockRestore();
		}
	});
});
