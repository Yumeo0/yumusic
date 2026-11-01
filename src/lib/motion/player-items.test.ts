import { expect, test } from "bun:test";
import {
	clipTextRect,
	prepareArtworkMorph,
	prepareTitleMorph,
	projectPlayerItem,
	scaledLengthAtProgress,
	textRect,
} from "./player-items";

test("fixed text label lengths retain their painted size while their parent scales", () => {
	for (const [size, radius] of [
		[320, 16],
		[64, 16],
	]) {
		const targetScale = 44 / size;
		for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
			const local = scaledLengthAtProgress(radius, 10, targetScale, progress);
			const scale = 1 + (targetScale - 1) * progress;
			expect(local * scale).toBeCloseTo(radius + (10 - radius) * progress);
		}
	}
});

test("unscaled lengths interpolate directly", () => {
	expect(scaledLengthAtProgress(16, 10, 1, 0)).toBe(16);
	expect(scaledLengthAtProgress(16, 10, 1, 0.5)).toBe(13);
	expect(scaledLengthAtProgress(16, 10, 1, 1)).toBe(10);
});

function withMotionElements(
	run: (
		make: (
			width: number,
			height: number,
			computed?: Record<string, string>,
			line?: HTMLElement,
		) => HTMLElement,
	) => void,
) {
	const previous = Object.getOwnPropertyDescriptor(
		globalThis,
		"getComputedStyle",
	);
	const styles = new Map<Element, Record<string, string>>();
	Object.defineProperty(globalThis, "getComputedStyle", {
		configurable: true,
		value: (element: Element) => styles.get(element) ?? {},
	});
	const make = (
		width: number,
		height: number,
		computed = {},
		line?: HTMLElement,
	) => {
		const element = {
			style: {
				width: "",
				height: "",
				position: "",
				left: "",
				top: "",
				borderRadius: "",
				borderWidth: "",
				fontWeight: "",
				letterSpacing: "",
			},
			getBoundingClientRect: () => ({ x: 0, y: 0, width, height }),
			querySelector: () => line ?? null,
			querySelectorAll: () => [],
		} as unknown as HTMLElement;
		styles.set(element, computed);
		return element;
	};
	try {
		run(make);
	} finally {
		if (previous)
			Object.defineProperty(globalThis, "getComputedStyle", previous);
		else Reflect.deleteProperty(globalThis, "getComputedStyle");
	}
}

test("artwork reaches the exact thumbnail box without scaling its border or moving the layout", () => {
	withMotionElements((make) => {
		for (const size of [320, 64]) {
			const frame = make(size, size);
			const artwork = make(size, size, {
				borderTopWidth: "1px",
				borderTopLeftRadius: "16px",
			});
			const thumbnail = make(44, 44, {
				borderTopWidth: "1px",
				borderTopLeftRadius: "10px",
			});
			const motion = prepareArtworkMorph(frame, artwork, thumbnail, true);
			motion.apply(1);
			expect(frame.style.width).toBe(`${size}px`);
			expect(artwork.style).toMatchObject({
				width: "44px",
				height: "44px",
				borderWidth: "1px",
				borderRadius: "10px",
			});
			expect(
				Number.parseFloat(artwork.style.width) -
					2 * Number.parseFloat(artwork.style.borderWidth),
			).toBe(42);
			motion.release();
			expect(frame.style.width).toBe("");
			expect(artwork.style).toMatchObject({
				width: "",
				height: "",
				position: "",
				borderWidth: "",
				borderRadius: "",
			});
		}
	});
});

test("title tracking matches the footer while its layout stays fixed and text can expand", () => {
	withMotionElements((make) => {
		const line = make(344, 36);
		const title = make(
			344,
			36,
			{ fontWeight: "700", letterSpacing: "-0.75px" },
			line,
		);
		const mini = make(168, 17.5, {
			fontWeight: "600",
			letterSpacing: "normal",
		});
		const motion = prepareTitleMorph(title, mini, 14 / 30);
		motion.apply(1);
		expect(title.style).toMatchObject({
			width: "344px",
			height: "36px",
			fontWeight: "600",
			letterSpacing: "0px",
		});
		expect(Number.parseFloat(line.style.width) * (14 / 30)).toBeCloseTo(168);
		motion.release();
		expect(title.style).toMatchObject({
			width: "",
			height: "",
			fontWeight: "",
			letterSpacing: "",
		});
		expect(line.style.width).toBe("");
	});
});

test("artist and title transitions measure inline glyphs rather than block line boxes", () => {
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	const previousRect = Object.getOwnPropertyDescriptor(globalThis, "DOMRect");
	class Rect {
		constructor(
			public x: number,
			public y: number,
			public width: number,
			public height: number,
		) {}
		get left() {
			return this.x;
		}
		get top() {
			return this.y;
		}
	}
	let selected: Element;
	const ranges = new Map<Element, Rect>();
	const layout = (row: Rect, glyphs: Rect): Element => {
		const inline = {
			querySelector: () => null,
			closest: () => ({ getBoundingClientRect: () => row }),
			getBoundingClientRect: () => glyphs,
		} as unknown as Element;
		const block = {
			querySelector: () => inline,
			closest: () => null,
			getBoundingClientRect: () => row,
		} as unknown as Element;
		// Range.selectNodeContents(block) includes the full-width paragraph;
		// selecting the dedicated inline node gives only the artist glyphs.
		ranges.set(block, row);
		ranges.set(inline, glyphs);
		return block;
	};
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createRange: () => ({
				selectNodeContents: (element: Element) => {
					selected = element;
				},
				getBoundingClientRect: () => ranges.get(selected),
			}),
		},
	});
	Object.defineProperty(globalThis, "DOMRect", {
		configurable: true,
		value: Rect,
	});
	try {
		const centered = textRect(
			layout(new Rect(24, 300, 352, 24), new Rect(170, 304, 60, 18)),
		);
		const compact = textRect(
			layout(new Rect(104, 660, 240, 24), new Rect(104, 664, 60, 18)),
		);
		const title = textRect(
			layout(new Rect(24, 350, 352, 36), new Rect(100, 353, 200, 30)),
		);
		const miniTitle = textRect(
			layout(new Rect(72, 730, 160, 17.5), new Rect(72, 731, 100, 16)),
		);
		expect(title.y).toBe(353);
		expect(title.height).toBe(30);
		expect(miniTitle.y).toBe(731);
		expect(miniTitle.height).toBe(16);
		expect(centered.x).toBe(170);
		expect(centered.width).toBe(60);
		for (const [from, to] of [
			[centered, compact],
			[compact, centered],
		]) {
			const dx = from.left - to.left;
			const dy = from.top - to.top;
			expect(to.x + dx).toBe(from.x);
			expect(to.y + dy).toBe(from.y);
		}
	} finally {
		if (previousDocument)
			Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (previousRect)
			Object.defineProperty(globalThis, "DOMRect", previousRect);
		else Reflect.deleteProperty(globalThis, "DOMRect");
	}
});

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
