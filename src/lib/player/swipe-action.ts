export const NEXT_THRESHOLD = 64;
export const QUEUE_THRESHOLD = 144;
export const REMOVE_THRESHOLD = 72;
export type SwipeAction = "next" | "queue" | "remove" | null;

export function swipeAction(distance: number, removable = false): SwipeAction {
	if (removable && distance <= -REMOVE_THRESHOLD) return "remove";
	if (distance >= QUEUE_THRESHOLD) return "queue";
	if (distance >= NEXT_THRESHOLD) return "next";
	return null;
}

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

/** Resist travel before each release point, then spring into the selected slot. */
export function swipeDetentOffset(
	distance: number,
	action: SwipeAction,
): number {
	if (action === "remove")
		return -104 + Math.max(-20, (distance + REMOVE_THRESHOLD) * 0.15);
	if (action === "queue")
		return 168 + Math.min(18, (distance - QUEUE_THRESHOLD) * 0.15);
	if (action === "next") return 96 + (distance - NEXT_THRESHOLD) * 0.16;
	return distance * 0.42;
}
