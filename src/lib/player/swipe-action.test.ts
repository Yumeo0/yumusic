import { expect, test } from "bun:test";
import { swipeAction, swipeDetent, swipeDetentOffset } from "./swipe-action";

test("right swipe has separate next and end-of-queue detents", () => {
	expect(swipeAction(63)).toBeNull();
	expect(swipeAction(64)).toBe("next");
	expect(swipeAction(143)).toBe("next");
	expect(swipeAction(144)).toBe("queue");
	expect(swipeAction(184)).toBe("queue");
	// Dragging back across the second detent restores Play next.
	expect(swipeAction(90)).toBe("next");
});

test("left swipe only removes removable queue entries", () => {
	expect(swipeAction(-120)).toBeNull();
	expect(swipeAction(-71, true)).toBeNull();
	expect(swipeAction(-72, true)).toBe("remove");
});

test("spring detents hold through small backward movements", () => {
	expect(swipeDetent(64, null)).toBe("next");
	expect(swipeDetent(55, "next")).toBe("next");
	expect(swipeDetent(43, "next")).toBeNull();
	expect(swipeDetent(144, "next")).toBe("queue");
	expect(swipeDetent(130, "queue")).toBe("queue");
	expect(swipeDetent(119, "queue")).toBe("next");
	expect(swipeDetent(-65, "remove", true)).toBe("remove");
	expect(swipeDetent(-53, "remove", true)).toBeNull();
});

test("each release point breaks resistance and snaps ahead into a distinct slot", () => {
	const resisted = swipeDetentOffset(63, null);
	const next = swipeDetentOffset(64, "next");
	const queue = swipeDetentOffset(144, "queue");
	expect(resisted).toBeLessThan(32);
	expect(next - resisted).toBeGreaterThan(60);
	expect(queue - next).toBeGreaterThan(60);
	expect(swipeDetentOffset(90, "next") - next).toBeLessThan(10);
});
