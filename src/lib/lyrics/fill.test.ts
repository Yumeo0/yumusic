import { describe, expect, test } from "bun:test";
import { readingSegments, wordProgress } from "./fill";

describe("wordProgress", () => {
	test("sweeps from 0 to 1 between start and end", () => {
		expect(wordProgress(10, 12, 9.99)).toBe(0);
		expect(wordProgress(10, 12, 10)).toBe(0);
		expect(wordProgress(10, 12, 11)).toBe(0.5);
		expect(wordProgress(10, 12, 12)).toBe(1);
		expect(wordProgress(10, 12, 13)).toBe(1);
	});

	test("zero-length words light up whole", () => {
		expect(wordProgress(10, 10, 9.9)).toBe(0);
		expect(wordProgress(10, 10, 10)).toBe(1);
		expect(wordProgress(10, 9, 10)).toBe(1);
	});
});

describe("readingSegments", () => {
	test("maps progress proportionally over the whole reading", () => {
		// "abcd ef" is 7 chars; a 50% sweep lands mid-way through "abcd".
		const segments = readingSegments("abcd ef", 0.5);
		expect(segments).toEqual([
			{ text: "abcd", start: 0, sung: 0.875 },
			{ text: " ", start: 4, sung: undefined },
			{ text: "ef", start: 5, sung: 0 },
		]);
	});

	test("progress 0 and 1 keep whitespace plain", () => {
		const empty = readingSegments("a bb", 0);
		expect(empty.map((segment) => segment.sung)).toEqual([0, undefined, 0]);
		const full = readingSegments("a bb", 1);
		expect(full.map((segment) => segment.sung)).toEqual([1, undefined, 1]);
	});

	test("segments cover the reading verbatim", () => {
		const text = "zankoku  na\ttenshi";
		const segments = readingSegments(text, 0.5);
		expect(segments.map((segment) => segment.text).join("")).toBe(text);
		expect(
			segments.every(
				(segment) => segment.sung !== undefined || /\s/.test(segment.text),
			),
		).toBe(true);
	});

	test("empty readings produce no segments", () => {
		expect(readingSegments("", 0.5)).toEqual([]);
	});
});
