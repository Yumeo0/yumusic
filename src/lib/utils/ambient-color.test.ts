import { describe, expect, test } from "bun:test";
import { DEFAULT_AMBIENT_COLOR, dominantAccentColor } from "./ambient-color";

function pixels(
	...groups: Array<{ count: number; rgba: number[] }>
): Uint8ClampedArray {
	return new Uint8ClampedArray(
		groups.flatMap(({ count, rgba }) =>
			Array.from({ length: count }, () => rgba).flat(),
		),
	);
}

function rgb(color: string): number[] {
	return color.match(/\d+/g)?.map(Number) ?? [];
}

describe("dominant artwork accent", () => {
	test("large red regions beat a tiny, brighter orange eye detail", () => {
		const [r, g, b] = rgb(
			dominantAccentColor(
				pixels(
					{ count: 300, rgba: [200, 20, 48, 255] },
					{ count: 200, rgba: [170, 25, 50, 255] },
					{ count: 1, rgba: [238, 139, 0, 255] },
				),
			),
		);
		expect(r).toBeGreaterThan(g * 3);
		expect(r).toBeGreaterThan(b * 2);
	});
	test("dominant blue still wins against a small saturated red detail", () => {
		const [r, g, b] = rgb(
			dominantAccentColor(
				pixels(
					{ count: 200, rgba: [30, 70, 190, 255] },
					{ count: 1, rgba: [255, 0, 0, 255] },
				),
			),
		);
		expect(b).toBeGreaterThan(r * 2);
		expect(b).toBeGreaterThan(g);
	});
	test("white and black backgrounds do not drown out the cover's colored regions", () => {
		const [r, , b] = rgb(
			dominantAccentColor(
				pixels(
					{ count: 800, rgba: [10, 10, 10, 255] },
					{ count: 800, rgba: [240, 240, 240, 255] },
					{ count: 100, rgba: [210, 20, 50, 255] },
				),
			),
		);
		expect(r).toBeGreaterThan(b * 2);
	});
	test("red shades across the hue-wheel boundary are grouped together", () => {
		const [r, g, b] = rgb(
			dominantAccentColor(
				pixels(
					{ count: 50, rgba: [200, 20, 35, 255] },
					{ count: 50, rgba: [200, 35, 20, 255] },
					{ count: 60, rgba: [0, 180, 0, 255] },
				),
			),
		);
		expect(r).toBeGreaterThan(g * 2);
		expect(r).toBeGreaterThan(b * 2);
	});
	test("transparent and faint pixels cannot outweigh opaque artwork", () => {
		const [r, , b] = rgb(
			dominantAccentColor(
				pixels(
					{ count: 1000, rgba: [255, 0, 0, 0] },
					{ count: 100, rgba: [255, 0, 0, 10] },
					{ count: 50, rgba: [20, 60, 200, 255] },
				),
			),
		);
		expect(b).toBeGreaterThan(r * 2);
	});
	test("neutral covers retain a readable warm accent", () => {
		const [r, g, b] = rgb(
			dominantAccentColor(pixels({ count: 100, rgba: [128, 128, 128, 255] })),
		);
		expect(r).toBeGreaterThan(g);
		expect(g).toBeGreaterThan(b);
		expect(r).toBeGreaterThan(180);
	});
	test("empty, fully transparent, and black artwork use the theme fallback", () => {
		for (const data of [
			new Uint8ClampedArray(),
			pixels({ count: 10, rgba: [255, 0, 0, 0] }),
			pixels({ count: 10, rgba: [0, 0, 0, 255] }),
		]) {
			expect(dominantAccentColor(data)).toBe(DEFAULT_AMBIENT_COLOR);
		}
	});
});
