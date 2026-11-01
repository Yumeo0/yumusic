import { expect, test } from "bun:test";
import { detectCoverCrop } from "./cover-crop";

function pixels(top: number, bottom: number, fill = 150) {
	const data = new Uint8ClampedArray(100 * 100 * 4);
	for (let y = 0; y < 100; y++)
		for (let x = 0; x < 100; x++) {
			const i = (y * 100 + x) * 4;
			data[i] =
				data[i + 1] =
				data[i + 2] =
					y < top || y >= 100 - bottom ? 0 : fill;
			data[i + 3] = 255;
		}
	return data;
}

test("paired letterbox bars are cropped with their JPEG seam", () => {
	expect(detectCoverCrop(pixels(11, 11), 100, 100)).toEqual({
		top: 0.12,
		bottom: 0.12,
	});
	expect(detectCoverCrop(pixels(23, 22), 100, 100)).toEqual({
		top: 0.24,
		bottom: 0.23,
	});
});
test("ordinary, all-dark and one-sided artwork is preserved", () => {
	expect(detectCoverCrop(pixels(0, 0), 100, 100)).toBeNull();
	expect(detectCoverCrop(pixels(0, 0, 0), 100, 100)).toBeNull();
	expect(detectCoverCrop(pixels(12, 0), 100, 100)).toBeNull();
	expect(detectCoverCrop(pixels(20, 3), 100, 100)).toBeNull();
});
test("transparent edges and invalid image data do not cause a crop", () => {
	const transparent = pixels(10, 10);
	for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
	expect(detectCoverCrop(transparent, 100, 100)).toBeNull();
	expect(detectCoverCrop([], 100, 100)).toBeNull();
});
