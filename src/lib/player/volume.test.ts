import { describe, expect, test } from "bun:test";
import {
	DEFAULT_VOLUME,
	linearToVolume,
	MAX_VOLUME,
	volumeForDevice,
	volumeToLinear,
} from "./volume";

describe("player volume", () => {
	test("phones use full app output even when a quiet or muted volume was saved", () => {
		for (const saved of [0, 0.001, DEFAULT_VOLUME, 0.5, MAX_VOLUME]) {
			expect(volumeForDevice(saved, true)).toBe(1);
			expect(volumeForDevice(saved, false)).toBe(saved);
		}
	});
	test("reaches full media output while retaining a quiet default", () => {
		expect(linearToVolume(0)).toBe(0);
		expect(linearToVolume(1)).toBe(1);
		expect(MAX_VOLUME).toBe(1);
		expect(DEFAULT_VOLUME).toBe(0.15);
	});

	test("gives quiet listening levels most of the lower half of the slider", () => {
		expect(linearToVolume(0.25)).toBeLessThan(0.02);
		expect(linearToVolume(0.5)).toBeLessThan(0.15);
		expect(volumeToLinear(0.15)).toBeGreaterThan(0.5);
		const quietStep = linearToVolume(0.11) - linearToVolume(0.1);
		const loudStep = linearToVolume(0.91) - linearToVolume(0.9);
		expect(quietStep).toBeLessThan(loudStep / 50);
	});

	test("preserves saved loudness, including mute, through slider conversion", () => {
		for (const volume of [0, 0.001, 0.01, 0.075, 0.15, 0.5, 1]) {
			expect(linearToVolume(volumeToLinear(volume))).toBeCloseTo(volume, 12);
		}
	});

	test("keeps output in the media element's supported range", () => {
		for (const value of [-1, -0.1, 1.1, 2]) {
			expect(linearToVolume(value)).toBeGreaterThanOrEqual(0);
			expect(linearToVolume(value)).toBeLessThanOrEqual(1);
			expect(volumeToLinear(value)).toBeGreaterThanOrEqual(0);
			expect(volumeToLinear(value)).toBeLessThanOrEqual(1);
		}
	});
});
