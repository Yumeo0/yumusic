import { expect, test } from "bun:test";
import { queueReleaseStage } from "./queue-stages";

test("slow drags settle at the nearest of the three detents on every screen size", () => {
	for (const height of [600, 800, 1200]) {
		expect(queueReleaseStage(0, height)).toBe("full");
		expect(queueReleaseStage(height * 0.2, height)).toBe("full");
		expect(queueReleaseStage(height * 0.4, height)).toBe("half");
		expect(queueReleaseStage(height * 0.6, height)).toBe("half");
		expect(queueReleaseStage(height * 0.8, height)).toBe("closed");
	}
});

test("a short flick can advance a detent while reversed momentum brings the sheet back", () => {
	expect(queueReleaseStage(740, 800)).toBe("closed");
	expect(queueReleaseStage(740, 800, -700, 800)).toBe("half");
	expect(queueReleaseStage(740, 800, -1500, 800)).toBe("half");
	expect(queueReleaseStage(740, 800, 1000, 800)).toBe("closed");
	expect(queueReleaseStage(300, 800, 1000, 400)).toBe("closed");
});

test("fast flicks from either endpoint keep the halfway stop reachable", () => {
	for (const height of [600, 800, 1200]) {
		for (const speed of [1500, 3000, 6000]) {
			for (const fraction of [0.1, 0.5]) {
				expect(
					queueReleaseStage(height * (1 - fraction), height, -speed, height),
				).toBe("half");
				expect(queueReleaseStage(height * fraction, height, speed, 0)).toBe(
					"half",
				);
			}
		}
	}
});

test("a second flick from halfway can expand or dismiss the sheet", () => {
	for (const height of [600, 800, 1200]) {
		expect(queueReleaseStage(height * 0.44, height, -700, height / 2)).toBe(
			"full",
		);
		expect(queueReleaseStage(height * 0.56, height, 700, height / 2)).toBe(
			"closed",
		);
	}
});

test("direct drags can still cross halfway and reach the opposite endpoint", () => {
	for (const height of [600, 800, 1200]) {
		expect(queueReleaseStage(height * 0.2, height, 0, height)).toBe("full");
		expect(queueReleaseStage(height * 0.2, height, -3000, height)).toBe("full");
		expect(queueReleaseStage(height * 0.8, height, 0, 0)).toBe("closed");
		expect(queueReleaseStage(height * 0.8, height, 3000, 0)).toBe("closed");
	}
});

test("re-grabbing a moving sheet uses its visible starting position", () => {
	expect(queueReleaseStage(420, 800, -1500, 480)).toBe("full");
	expect(queueReleaseStage(680, 800, -3000, 740)).toBe("half");
});

test("projection clamps to the available detents even after boundary resistance", () => {
	expect(queueReleaseStage(-40, 800, -2000)).toBe("full");
	expect(queueReleaseStage(850, 800, 2000)).toBe("closed");
	expect(queueReleaseStage(0, 0)).toBe("full");
});
