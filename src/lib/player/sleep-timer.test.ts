import { describe, expect, test } from "bun:test";
import { SleepTimerStore, sleepTimerLabel } from "./sleep-timer";

describe("sleep timer song boundaries", () => {
	test("duration finishes a song that crosses its deadline, without stopping the earlier song", () => {
		const timer = new SleepTimerStore();
		timer.afterMinutes(1, 1000);
		expect(timer.trackEnded(0, 4, 60_999)).toBe(false);
		expect(timer.getSnapshot()?.mode).toBe("duration");
		const active = timer.getSnapshot();
		if (!active) throw new Error("Expected an active duration timer");
		expect(sleepTimerLabel(active, 61_000)).toBe("After this song finishes");
		expect(timer.trackEnded(1, 4, 100_000)).toBe(true);
		expect(timer.getSnapshot()).toBeNull();
		expect(timer.trackEnded(2, 4, 120_000)).toBe(false);
	});
	test("duration includes time spent paused or in the background", () => {
		const timer = new SleepTimerStore();
		timer.afterMinutes(30, 0);
		expect(timer.trackEnded(0, 1, 3_600_000)).toBe(true);
	});
	test("song count includes the current song and repeated occurrences", () => {
		const timer = new SleepTimerStore();
		timer.afterSongs(3);
		expect(timer.trackEnded(0, 1)).toBe(false);
		expect(timer.getSnapshot()).toEqual({ mode: "songs", remaining: 2 });
		expect(timer.trackEnded(0, 1)).toBe(false);
		expect(timer.trackEnded(0, 1)).toBe(true);
	});
	test("finish queue follows additions and stops before wrapping or autoplay", () => {
		const timer = new SleepTimerStore();
		timer.finishQueue();
		expect(timer.trackEnded(0, 2)).toBe(false);
		expect(timer.trackEnded(1, 3)).toBe(false);
		expect(timer.trackEnded(2, 3)).toBe(true);
	});
	test("a replacement or cancellation removes the earlier timer", () => {
		const timer = new SleepTimerStore();
		timer.afterSongs(1);
		timer.afterMinutes(30, 0);
		expect(timer.trackEnded(0, 1, 1000)).toBe(false);
		timer.cancel();
		expect(timer.trackEnded(0, 1, 9_999_999)).toBe(false);
	});
	test("invalid input leaves the active timer intact", () => {
		const timer = new SleepTimerStore();
		timer.finishQueue();
		for (const invalid of [0, -1, NaN, Infinity]) {
			timer.afterMinutes(invalid);
			timer.afterSongs(invalid);
		}
		expect(timer.getSnapshot()).toEqual({ mode: "queue" });
	});
});
