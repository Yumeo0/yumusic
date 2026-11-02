import { expect, test } from "bun:test";
import { QUEUE_STAGES, queueDragStage, queueStageOffset } from "./queue-stages";

test("original 64 px threshold moves exactly one stage in either direction", () => {
	expect(queueDragStage("closed", 64)).toBe("half");
	expect(queueDragStage("half", 64)).toBe("full");
	expect(queueDragStage("full", -64)).toBe("half");
	expect(queueDragStage("half", -64)).toBe("closed");
	expect(queueDragStage("closed", 1000)).toBe("half");
	expect(queueDragStage("full", -1000)).toBe("half");
	expect(queueDragStage("full", 64)).toBe("full");
	expect(queueDragStage("closed", -64)).toBe("closed");
});

test("short and reversed drags return to their original stage", () => {
	for (const stage of QUEUE_STAGES) {
		for (const distance of [-63, -20, 0, 20, 63])
			expect(queueDragStage(stage, distance)).toBe(stage);
	}
	expect(queueDragStage("half", 64)).toBe("full");
	expect(queueDragStage("half", 20)).toBe("half");
	expect(queueDragStage("half", -64)).toBe("closed");
});

test("finger-follow and spring capture do not change the release threshold", () => {
	for (const height of [600, 800, 1200]) {
		const stage = queueDragStage("closed", 64);
		expect(stage).toBe("half");
		expect(queueStageOffset("closed", stage, 64, height)).toBe(height - 64);
	}
	expect(queueStageOffset("closed", "half", 364, 800)).toBe(400);
	expect(queueStageOffset("closed", "half", 500, 800)).toBe(300);
	expect(queueStageOffset("full", "closed", -1000, 800)).toBe(800);
});
