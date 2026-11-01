export interface CoverCrop {
	top: number;
	bottom: number;
}

/** Only remove near-black, flat, paired borders; dark artwork stays intact. */
export function detectCoverCrop(
	data: ArrayLike<number>,
	width: number,
	height: number,
): CoverCrop | null {
	if (width < 8 || height < 16 || data.length < width * height * 4) return null;
	const black = (y: number) => {
		let dark = 0;
		let count = 0;
		for (let x = 1; x < width - 1; x++) {
			const i = (y * width + x) * 4;
			if (data[i + 3] > 240 && Math.max(data[i], data[i + 1], data[i + 2]) < 22)
				dark++;
			count++;
		}
		return dark / count >= 0.985;
	};
	let top = 0;
	let bottom = 0;
	while (top < height / 3 && black(top)) top++;
	while (bottom < height / 3 && black(height - bottom - 1)) bottom++;
	const minimum = Math.max(2, Math.floor(height * 0.02));
	if (
		top < minimum ||
		bottom < minimum ||
		Math.abs(top - bottom) > Math.max(2, height * 0.035) ||
		top + bottom >= height * 0.55
	)
		return null;
	// One extra sampled row removes the JPEG seam at the border.
	return { top: (top + 1) / height, bottom: (bottom + 1) / height };
}

const cache = new Map<string, Promise<CoverCrop | null>>();
export function loadCoverCrop(src: string): Promise<CoverCrop | null> {
	const existing = cache.get(src);
	if (existing) return existing;
	const result = (async () => {
		try {
			const response = await fetch(src, { mode: "cors" });
			if (!response.ok) return null;
			const bitmap = await createImageBitmap(await response.blob());
			try {
				const canvas = document.createElement("canvas");
				canvas.width = canvas.height = 128;
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) return null;
				ctx.drawImage(bitmap, 0, 0, 128, 128);
				return detectCoverCrop(ctx.getImageData(0, 0, 128, 128).data, 128, 128);
			} finally {
				bitmap.close();
			}
		} catch {
			return null;
		}
	})();
	cache.set(src, result);
	if (cache.size > 200) cache.delete(cache.keys().next().value as string);
	return result;
}
