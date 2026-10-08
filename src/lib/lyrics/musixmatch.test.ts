import { describe, expect, test } from "bun:test";
import { parseRichsync } from "./musixmatch";

describe("parseRichsync", () => {
	test("keeps per-word timings on each line", () => {
		const body = JSON.stringify([
			{
				ts: "12.5",
				l: [
					{ c: "We're", o: 0 },
					{ c: " no", o: 0.5 },
					{ c: " strangers", o: 0.9 },
				],
			},
			{
				ts: "15.2",
				l: [
					{ c: "to", o: 0 },
					{ c: " love", o: 0.4 },
				],
			},
		]);
		const lines = parseRichsync(body);
		expect(lines).toHaveLength(2);
		expect(lines[0].text).toBe("We're no strangers");
		expect(lines[0].words?.map((word) => word.time)).toEqual([12.5, 13, 13.4]);
		expect(lines[1].words?.[1].text).toBe(" love");
		expect(lines[1].words?.[1].time).toBeCloseTo(15.6);
	});

	test("lines without words still parse", () => {
		const body = JSON.stringify([{ ts: "3.5", l: [] }]);
		const lines = parseRichsync(body);
		expect(lines).toHaveLength(0);
	});

	test("malformed payloads resolve to an empty list", () => {
		expect(parseRichsync("not json")).toEqual([]);
		expect(parseRichsync("{}")).toEqual([]);
	});
});
