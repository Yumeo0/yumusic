export const DEFAULT_AMBIENT_COLOR = "rgb(255, 19, 74)";

interface ColorGroup {
	weight: number;
	r: number;
	g: number;
	b: number;
}

/** Keep the selected hue readable against the app's dark background. */
function boostColor(r: number, g: number, b: number): string {
	const max = Math.max(r, g, b) || 1;
	const min = Math.min(r, g, b);
	const sat = (max - min) / max;
	const scale = Math.min(205 / max, 2.6);
	let nr = Math.round(Math.min(255, r * scale));
	let ng = Math.round(Math.min(255, g * scale));
	let nb = Math.round(Math.min(255, b * scale));
	const lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
	if (lum < 80) {
		const lift = Math.min(80 / Math.max(lum, 1), 1.8);
		nr = Math.round(Math.min(255, nr * lift + 12));
		ng = Math.round(Math.min(255, ng * lift + 12));
		nb = Math.round(Math.min(255, nb * lift + 12));
	}
	// Preserve the existing warm treatment for neutral artwork.
	if (sat < 0.18) {
		nr = Math.round(nr * 0.92 + 24);
		ng = Math.round(ng * 0.8 + 18);
		nb = Math.round(nb * 0.45 + 8);
	}
	return `rgb(${nr}, ${ng}, ${nb})`;
}

/**
 * Group RGBA pixels into hue families, weighted by coverage, saturation and
 * opacity. Nearby shades reinforce each other; a tiny vivid detail cannot
 * win just by having the image's highest individual saturation.
 */
export function dominantAccentColor(pixels: ArrayLike<number>): string {
	const groups: ColorGroup[] = Array.from({ length: 24 }, () => ({
		weight: 0,
		r: 0,
		g: 0,
		b: 0,
	}));
	const neutral: ColorGroup = { weight: 0, r: 0, g: 0, b: 0 };
	for (let i = 0; i + 3 < pixels.length; i += 4) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];
		const alpha = pixels[i + 3] / 255;
		const max = Math.max(r, g, b);
		const delta = max - Math.min(r, g, b);
		// Ignore transparent pixels and near-black backgrounds/baked-in bars.
		if (alpha === 0 || max < 32) continue;
		const brightness = max / 255;
		const neutralWeight = alpha * brightness;
		neutral.weight += neutralWeight;
		neutral.r += r * neutralWeight;
		neutral.g += g * neutralWeight;
		neutral.b += b * neutralWeight;
		const saturation = delta / max;
		if (saturation < 0.18) continue;
		const hue =
			(((max === r
				? (g - b) / delta
				: max === g
					? (b - r) / delta + 2
					: (r - g) / delta + 4) +
				6) %
				6) *
			60;
		const index = Math.round(hue / 15) % groups.length;
		const weight = alpha * saturation * (0.5 + brightness * 0.5);
		const group = groups[index];
		group.weight += weight;
		group.r += r * weight;
		group.g += g * weight;
		group.b += b * weight;
	}

	// Smooth neighboring families around the hue wheel, including the red seam.
	let selected: ColorGroup = neutral;
	let bestScore = 0;
	for (let i = 0; i < groups.length; i++) {
		const combined: ColorGroup = { weight: 0, r: 0, g: 0, b: 0 };
		for (const offset of [-1, 0, 1]) {
			const group = groups[(i + offset + groups.length) % groups.length];
			const factor = offset === 0 ? 1 : 0.5;
			combined.weight += group.weight * factor;
			combined.r += group.r * factor;
			combined.g += group.g * factor;
			combined.b += group.b * factor;
		}
		if (combined.weight > bestScore) {
			bestScore = combined.weight;
			selected = combined;
		}
	}
	return selected.weight > 0
		? boostColor(
				selected.r / selected.weight,
				selected.g / selected.weight,
				selected.b / selected.weight,
			)
		: DEFAULT_AMBIENT_COLOR;
}
