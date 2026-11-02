import type { QueueState } from "@/lib/player/player-ui";

export const QUEUE_STAGES: QueueState[] = ["full", "half", "closed"];

/** Preserve the original gesture: 64 px advances one stage, on any screen. */
export function queueDragStage(rest: QueueState, distance: number): QueueState {
	if (Math.abs(distance) < 64) return rest;
	const index = QUEUE_STAGES.indexOf(rest) + (distance > 0 ? -1 : 1);
	return QUEUE_STAGES[Math.max(0, Math.min(2, index))];
}

export function queueStageOffset(
	rest: QueueState,
	stage: QueueState,
	distance: number,
	height: number,
): number {
	const index = QUEUE_STAGES.indexOf(stage);
	const finger = Math.max(
		0,
		Math.min(height, (QUEUE_STAGES.indexOf(rest) * height) / 2 - distance),
	);
	const destination = (index * height) / 2;
	if (stage === rest) return finger;
	return Math.abs(finger - destination) <= Math.min(36, height * 0.045)
		? destination
		: finger;
}
