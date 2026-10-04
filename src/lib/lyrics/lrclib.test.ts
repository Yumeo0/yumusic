import { afterEach, describe, expect, test } from "bun:test";
import { fetchSyncedLyrics, parseLrc } from "./lrclib";

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

describe("fetchSyncedLyrics ranking", () => {
	const realFetch = globalThis.fetch;

	/** Serves the given records to every LRCLIB search request. */
	function stubRecords(records: unknown[]) {
		const stub = async () =>
			new Response(JSON.stringify(records), {
				headers: { "Content-Type": "application/json" },
				status: 200,
			});
		globalThis.fetch = Object.assign(stub, {
			preconnect: () => undefined,
		}) as typeof fetch;
	}

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("a clean duplicate wins over an offset-carrying copy", async () => {
		stubRecords([
			{
				duration: 202,
				plainLyrics: null,
				syncedLyrics: "[offset:-1044]\n[00:00.43] Hi\n[00:13.00] Thanks",
			},
			{
				duration: 202,
				plainLyrics: null,
				syncedLyrics: "[00:00.43] Hi\n[00:13.00] Thanks",
			},
		]);
		const result = await fetchSyncedLyrics(
			"MINIMUM RAGE",
			"MonochroMenace",
			202,
		);
		expect(result?.confirmed).toBe(true);
		expect(result?.synced?.[0].time).toBeCloseTo(0.43);
	});

	test("the offset is still applied when every copy carries one", async () => {
		stubRecords([
			{
				duration: 202,
				plainLyrics: null,
				syncedLyrics: "[offset:-1044]\n[00:00.43] Hi",
			},
		]);
		const result = await fetchSyncedLyrics(
			"MINIMUM RAGE",
			"MonochroMenace",
			202,
		);
		expect(result?.synced?.[0].time).toBeCloseTo(1.474);
	});
});
