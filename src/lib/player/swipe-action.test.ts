import { expect, test } from "bun:test";
import { swipeDetent } from "./swipe-action";

test("right swipe has separate next and end-of-queue detents", () => {
	expect(swipeDetent(63, null)).toBeNull();
	expect(swipeDetent(64, null)).toBe("next");
	expect(swipeDetent(143, "next")).toBe("next");
	expect(swipeDetent(144, "next")).toBe("queue");
	expect(swipeDetent(119, "queue")).toBe("next");
});

test("left swipe only removes removable queue entries", () => {
	expect(swipeDetent(-120, null)).toBeNull();
	expect(swipeDetent(-71, null, true)).toBeNull();
	expect(swipeDetent(-72, null, true)).toBe("remove");
});

test("spring detents hold through small backward movements", () => {
	expect(swipeDetent(55, "next")).toBe("next");
	expect(swipeDetent(43, "next")).toBeNull();
	expect(swipeDetent(130, "queue")).toBe("queue");
	expect(swipeDetent(-65, "remove", true)).toBe("remove");
	expect(swipeDetent(-53, "remove", true)).toBeNull();
});
