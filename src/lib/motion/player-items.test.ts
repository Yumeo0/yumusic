import { expect, test } from "bun:test";
import { clipTextRect, projectPlayerItem } from "./player-items";

test("album text and title glyphs land independently in the compact artist line", () => {
	const origin = { x: 24, y: 360, width: 352, height: 24 };
	const source = { x: 140, y: 362, width: 120, height: 18 };
	const target = { x: 213, y: 752, width: 103, height: 15 };
	const scale = 12 / 14;
	const delta = projectPlayerItem(origin, source, target, scale);
	for (const progress of [0, 0.25, 0.5, 1]) {
		const size = 1 + (scale - 1) * progress;
		// The parent slides offscreen while each paired child cancels that
		// slide; its text follows a straight path to the actual footer glyphs.
		const pageSlide = 850 * progress;
		const centerX =
			origin.x +
			delta.x * progress +
			size * (source.x + source.width / 2 - origin.x);
		const centerY =
			pageSlide +
			origin.y +
			delta.y * progress -
			pageSlide +
			size * (source.y + source.height / 2 - origin.y);
		expect(centerX).toBeCloseTo(
			source.x +
				source.width / 2 +
				(target.x + target.width / 2 - source.x - source.width / 2) * progress,
		);
		expect(centerY).toBeCloseTo(
			source.y +
				source.height / 2 +
				(target.y + target.height / 2 - source.y - source.height / 2) *
					progress,
		);
	}
});

test("truncated metadata uses its visible glyphs instead of offscreen text", () => {
	const clip = { x: 72, y: 740, width: 140, height: 16 };
	expect(clipTextRect({ x: 72, y: 741, width: 450, height: 14 }, clip)).toEqual(
		{ x: 72, y: 741, width: 140, height: 14 },
	);
	// An album fully clipped after a long artist has no visible destination.
	// The dismiss animation must fade it down rather than fly it offscreen.
	expect(
		clipTextRect({ x: 270, y: 741, width: 100, height: 14 }, clip).width,
	).toBe(0);
});

test("a long title keeps its leading edge aligned when its footer copy truncates", () => {
	const origin = { x: 24, y: 300, width: 352, height: 32 };
	const source = { x: 50, y: 302, width: 300, height: 28 };
	const target = { x: 72, y: 730, width: 120, height: 16 };
	const scale = 14 / 24;
	const delta = projectPlayerItem(origin, source, target, scale, "start");
	expect(origin.x + delta.x + scale * (source.x - origin.x)).toBeCloseTo(
		target.x,
	);
});
