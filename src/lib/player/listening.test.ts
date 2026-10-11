import { describe, expect, test } from "bun:test";
import {
	LISTEN_GRACE_SECONDS,
	listeningSession,
	scrobbleThresholdSeconds,
} from "./listening";

/** Collects the shared session's events for one test. */
function recordEvents(): { events: string[]; stop: () => void } {
	const events: string[] = [];
	const stop = listeningSession.subscribe((event) => events.push(event));
	return { events, stop };
}

describe("scrobbleThresholdSeconds", () => {
	test("half the track, clamped to 30s–4min", () => {
		expect(scrobbleThresholdSeconds(200)).toBe(100);
		expect(scrobbleThresholdSeconds(40)).toBe(30);
		expect(scrobbleThresholdSeconds(1200)).toBe(240);
	});

	test("a missing or non-finite length falls back to 4 minutes", () => {
		expect(scrobbleThresholdSeconds(0)).toBe(240);
		expect(scrobbleThresholdSeconds(Number.NaN)).toBe(240);
		expect(scrobbleThresholdSeconds(Number.POSITIVE_INFINITY)).toBe(240);
	});
});

describe("listeningSession", () => {
	test("fires established after the grace period, then scrobbled at half the track", () => {
		const { events, stop } = recordEvents();
		listeningSession.start("track-a", 200);
		for (let i = 0; i < LISTEN_GRACE_SECONDS; i++) listeningSession.tick();
		expect(events).toEqual(["established"]);
		for (let i = 0; i < 95; i++) listeningSession.tick();
		expect(events).toEqual(["established", "scrobbled"]);
		stop();
	});

	test("a non-finite start duration is repaired once the length is known", () => {
		// The media element reports NaN/Infinity until its metadata is ready.
		// Such a duration must not pin the threshold to the 4-minute fallback
		// (which left sub-4-minute tracks without a scrobble).
		const { events, stop } = recordEvents();
		listeningSession.start("track-b", Number.NaN);
		listeningSession.setDuration(200);
		for (let i = 0; i < 101; i++) listeningSession.tick();
		expect(events).toContain("scrobbled");
		stop();
	});

	test("re-arming the same track keeps its accumulated listening", () => {
		listeningSession.start("track-c", 200);
		for (let i = 0; i < 30; i++) listeningSession.tick();
		listeningSession.start("track-c", 200);
		expect(listeningSession.elapsed).toBe(30);
	});

	test("a new track resets progress and events", () => {
		const { events, stop } = recordEvents();
		listeningSession.start("track-d", 200);
		for (let i = 0; i < 30; i++) listeningSession.tick();
		expect(listeningSession.elapsed).toBe(30);
		listeningSession.start("track-e", 200);
		expect(listeningSession.elapsed).toBe(0);
		for (let i = 0; i < 110; i++) listeningSession.tick();
		// The second "established" proves the new track re-armed the session.
		expect(events).toEqual(["established", "established", "scrobbled"]);
		stop();
	});
});
