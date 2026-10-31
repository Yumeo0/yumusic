import { describe, expect, test } from "bun:test";
import { BufferingWatchdog } from "./buffering-watchdog";

describe("guest buffering timeout", () => {
	test("a host seek minutes into a playing track gets a fresh recovery window", () => {
		const watchdog = new BufferingWatchdog();
		watchdog.begin(0);
		expect(watchdog.expired(1000, true)).toBe(false);
		expect(watchdog.expired(120000, true)).toBe(false);
		watchdog.begin(120100);
		expect(watchdog.expired(120250, false)).toBe(false);
		expect(watchdog.expired(122000, true)).toBe(false);
		watchdog.begin(180000);
		expect(watchdog.expired(180150, false)).toBe(false);
	});

	test("spontaneous buffering also starts a new timeout after healthy playback", () => {
		const watchdog = new BufferingWatchdog();
		watchdog.begin(0);
		watchdog.expired(1000, true);
		expect(watchdog.expired(60000, false)).toBe(false);
		expect(watchdog.expired(89999, false)).toBe(false);
		expect(watchdog.expired(90001, false)).toBe(true);
	});

	test("a continuous stalled initial load or seek still times out", () => {
		const watchdog = new BufferingWatchdog();
		watchdog.begin(5000);
		expect(watchdog.expired(34999, false)).toBe(false);
		expect(watchdog.expired(35001, false)).toBe(true);
	});

	test("reconnection and a newer seek discard the previous timeout", () => {
		const watchdog = new BufferingWatchdog();
		watchdog.begin(0);
		watchdog.clear();
		expect(watchdog.expired(90000, false)).toBe(false);
		watchdog.begin(119000);
		expect(watchdog.expired(121000, false)).toBe(false);
	});
});
