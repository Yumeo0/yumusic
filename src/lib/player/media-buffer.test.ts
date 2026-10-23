import { describe, expect, test } from "bun:test";
import { bufferedAhead, containsTime } from "./media-buffer";

const ranges = (values: number[][]): TimeRanges => ({
	length: values.length,
	start: (i) => values[i][0],
	end: (i) => values[i][1],
});

describe("audio buffer window", () => {
	test("counts only contiguous audio ahead, not later buffered islands", () => {
		const buffered = ranges([
			[0, 20],
			[60, 100],
		]);
		expect(bufferedAhead(buffered, 10)).toBe(10);
		expect(bufferedAhead(buffered, 35)).toBe(0);
		expect(bufferedAhead(buffered, 75)).toBe(25);
	});
	test("seeks to evicted data and the end of a range require a new stream", () => {
		const buffered = ranges([[30, 75]]);
		expect(containsTime(buffered, 5)).toBe(false);
		expect(containsTime(buffered, 30)).toBe(true);
		expect(containsTime(buffered, 75)).toBe(false);
		expect(containsTime(ranges([]), 0)).toBe(false);
	});
});
