export const NEXT_THRESHOLD = 64;
const QUEUE_THRESHOLD = 144;
const REMOVE_THRESHOLD = 72;
export type SwipeAction = "next" | "queue" | "remove" | null;

/** Separate entry/exit thresholds stop a detent chattering under the finger. */
export function swipeDetent(
	distance: number,
	previous: SwipeAction,
	removable = false,
): SwipeAction {
	if (removable && distance <= -(previous === "remove" ? 54 : REMOVE_THRESHOLD))
		return "remove";
	if (distance >= (previous === "queue" ? 120 : QUEUE_THRESHOLD))
		return "queue";
	if (
		distance >=
		(previous === "next" || previous === "queue" ? 44 : NEXT_THRESHOLD)
	)
		return "next";
	return null;
}
