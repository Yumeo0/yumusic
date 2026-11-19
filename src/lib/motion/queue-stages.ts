import type { QueueState } from "@/lib/player/player-ui";
import { projectMomentum } from "./spring";

export const QUEUE_STAGES: QueueState[] = ["full", "half", "closed"];

/** Momentum advances one detent; direct travel can still cross multiple detents. */
export function queueReleaseStage(
	position: number,
	height: number,
	velocity = 0,
	origin = position,
): QueueState {
	const nearest = (offset: number) =>
		Math.max(
			0,
			Math.min(
				QUEUE_STAGES.length - 1,
				Math.round(offset / Math.max(1, height / 2)),
			),
		);
	const from = nearest(origin);
	const dragged = nearest(position);
	const projected = nearest(position + projectMomentum(velocity));
	// A fast, short flick must not skip the halfway stop. Dragging close to
	// the far endpoint explicitly makes it reachable, regardless of speed.
	const first = Math.max(0, Math.min(from - 1, dragged));
	const last = Math.min(QUEUE_STAGES.length - 1, Math.max(from + 1, dragged));
	const index = Math.max(first, Math.min(last, projected));
	return QUEUE_STAGES[index];
}
