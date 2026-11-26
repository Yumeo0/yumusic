import { describe, expect, test } from "bun:test";
import { parseLrc } from "./lrc";

describe("parseLrc", () => {
	test("parses timestamps, fractions and multiple stamps per line", () => {
		const lines = parseLrc(
			"[00:12.34] hello\n[01:02.5][01:03] world\nnot a timestamp",
		);
		expect(lines.map((line) => line.text)).toEqual(["hello", "world", "world"]);
		expect(lines[0].time).toBeCloseTo(12.34);
		expect(lines[1].time).toBeCloseTo(62.5);
		expect(lines[2].time).toBeCloseTo(63);
	});

	test("a positive offset makes lines appear sooner", () => {
		const [line] = parseLrc("[offset:+500]\n[00:10.00] hi");
		expect(line.time).toBeCloseTo(9.5);
	});

	test("a negative offset makes lines appear later", () => {
		const [line] = parseLrc("[offset:-1044]\r\n[00:00.43] Hi\r");
		expect(line.time).toBeCloseTo(1.474);
		expect(line.text).toBe("Hi");
	});

	test("lines pushed before the start are clamped to zero", () => {
		const [line] = parseLrc("[offset:+5000]\n[00:01.00] hi");
		expect(line.time).toBe(0);
	});
});
