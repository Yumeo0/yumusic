import { afterEach, describe, expect, test } from "bun:test";
import { fetchSyncedLyrics } from "./lrclib";

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
