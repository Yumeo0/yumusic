import { expect, test } from "bun:test";
import { Virtualizer } from "@tanstack/react-virtual";
import { queueScrollOffset } from "./queue-scroll";

test("half-open queues center the current song above the screen edge", () => {
	for (const screenHeight of [600, 800, 1200]) {
		const headerHeight = 64;
		const height = screenHeight - headerHeight;
		const hiddenHeight = screenHeight / 2;
		const paddingTop = 8;
		for (const index of [4, 20, 500]) {
			const row = { start: index * 58, size: 58 };
			const offset = queueScrollOffset(row, {
				height,
				hiddenHeight,
				paddingTop,
				scrollHeight: 1000 * 58 + paddingTop * 2 + hiddenHeight,
			});
			const visibleTop = hiddenHeight + headerHeight;
			const songCenter =
				visibleTop + paddingTop + row.start + row.size / 2 - offset;
			expect(songCenter).toBeCloseTo((visibleTop + screenHeight) / 2);
		}
	}
});

test("the first and last songs stay visible when centering reaches a list boundary", () => {
	for (const count of [1, 8, 1000]) {
		const height = 736;
		const hiddenHeight = 400;
		const visibleHeight = height - hiddenHeight;
		const paddingTop = 8;
		const scrollHeight = Math.max(
			height,
			count * 58 + paddingTop * 2 + hiddenHeight,
		);
		for (const index of [0, count - 1]) {
			const row = { start: index * 58, size: 58 };
			const offset = queueScrollOffset(row, {
				height,
				hiddenHeight,
				paddingTop,
				scrollHeight,
			});
			const top = paddingTop + row.start - offset;
			expect(offset).toBeGreaterThanOrEqual(0);
			expect(offset).toBeLessThanOrEqual(scrollHeight - height);
			expect(top).toBeGreaterThanOrEqual(0);
			expect(top + row.size).toBeLessThanOrEqual(visibleHeight);
		}
	}
});

test("fullscreen and desktop drawers use their entire scroll viewport", () => {
	const row = { start: 1160, size: 76 };
	for (const height of [536, 736, 1136]) {
		const paddingTop = 8;
		const offset = queueScrollOffset(row, {
			height,
			hiddenHeight: 0,
			paddingTop,
			scrollHeight: 5800,
		});
		expect(paddingTop + row.start + row.size / 2 - offset).toBeCloseTo(
			height / 2,
		);
	}
});

test("virtual row measurements update the center after differing row heights are discovered", () => {
	const virtualizer = new Virtualizer<HTMLElement, HTMLElement>({
		count: 1000,
		getScrollElement: () => null,
		estimateSize: () => 58,
		observeElementRect: () => undefined,
		observeElementOffset: () => undefined,
		scrollToFn: () => undefined,
	});
	for (const measured of [false, true]) {
		if (measured) {
			virtualizer.resizeItem(4, 76);
			virtualizer.resizeItem(20, 96);
		}
		const scrollHeight = virtualizer.getTotalSize() + 416;
		const row = virtualizer.measurementsCache[20];
		const offset = queueScrollOffset(row, {
			height: 736,
			hiddenHeight: 400,
			paddingTop: 8,
			scrollHeight,
		});
		expect(8 + row.start + row.size / 2 - offset).toBeCloseTo(168);
	}
});
