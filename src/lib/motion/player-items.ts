/** Remaining player elements, paired separately so metadata never travels as
 * part of a differently sized title/artist block. Missing targets fade downward. */
export const PLAYER_SECONDARY_PAIRS = [
	{ selector: "[data-np-album]", target: "[data-mini-album]", text: true },
	{ selector: "[data-np-download]", target: "[data-mini-download]" },
	{ selector: "[data-np-repeat]", target: "[data-mini-repeat]" },
	{ selector: "[data-np-room]", target: "[data-mini-room]" },
	{ selector: "[data-np-audio]", target: "[data-mini-audio]" },
	{
		selector: "[data-np-ratings] [data-rating=like]",
		target: "[data-mini-ratings] [data-rating=like]",
	},
	{
		selector: "[data-np-ratings] [data-rating=dislike]",
		target: "[data-mini-ratings] [data-rating=dislike]",
	},
	{ selector: "[data-np-elapsed]", target: "[data-mini-elapsed]", text: true },
	{
		selector: "[data-np-duration]",
		target: "[data-mini-duration]",
		text: true,
	},
	{ selector: "[data-np-queue]", target: "[data-mini-queue]" },
] as const;

export interface MotionRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Interpolate a painted length while cancelling its element's scale. */
export function scaledLengthAtProgress(
	from: number,
	to: number,
	targetScale: number,
	progress: number,
) {
	const scale = 1 + (targetScale - 1) * progress;
	return (from + (to - from) * progress) / Math.max(scale, 0.001);
}

/** Resize the painted artwork independently of its resting layout box. */
export function prepareArtworkMorph(
	cover: HTMLElement,
	artwork: HTMLElement,
	target: HTMLElement,
	resize: boolean,
) {
	const box = cover.getBoundingClientRect();
	const from = artwork.getBoundingClientRect();
	const to = target.getBoundingClientRect();
	const sourceStyle = getComputedStyle(artwork);
	const targetStyle = getComputedStyle(target);
	const fromRadius = Number.parseFloat(sourceStyle.borderTopLeftRadius) || 0;
	const toRadius = Number.parseFloat(targetStyle.borderTopLeftRadius) || 0;
	const fromBorder = Number.parseFloat(sourceStyle.borderTopWidth) || 0;
	const toBorder = Number.parseFloat(targetStyle.borderTopWidth) || 0;
	const original = Object.fromEntries(
		(
			[
				"width",
				"height",
				"position",
				"left",
				"top",
				"borderRadius",
				"borderWidth",
				"overflow",
			] as const
		).map((property) => [property, artwork.style[property]]),
	);
	const originalBox = { width: cover.style.width, height: cover.style.height };
	const icon = artwork.querySelector<SVGElement>("svg");
	const originalIconOpacity = icon?.style.opacity ?? "";
	artwork.style.overflow = "hidden";
	if (resize) {
		// Hold the flex layout still while the artwork shrinks inside it.
		cover.style.width = `${box.width}px`;
		cover.style.height = `${box.height}px`;
		Object.assign(artwork.style, {
			position: "absolute",
			left: `${from.x - box.x}px`,
			top: `${from.y - box.y}px`,
		});
	}
	return {
		x: to.x - from.x,
		y: to.y - from.y,
		apply: (progress: number) => {
			if (icon) icon.style.opacity = String(1 - progress);
			if (resize) {
				artwork.style.width = `${from.width + (to.width - from.width) * progress}px`;
				artwork.style.height = `${from.height + (to.height - from.height) * progress}px`;
			}
			artwork.style.borderRadius = `${fromRadius + (toRadius - fromRadius) * progress}px`;
			artwork.style.borderWidth = `${fromBorder + (toBorder - fromBorder) * progress}px`;
		},
		release: () => {
			Object.assign(artwork.style, original);
			if (icon) icon.style.opacity = originalIconOpacity;
			if (resize) Object.assign(cover.style, originalBox);
		},
	};
}

/** Match footer typography without changing the centered heading's layout box. */
export function prepareTitleMorph(
	title: HTMLElement,
	target: HTMLElement,
	scale: number,
) {
	const sourceStyle = getComputedStyle(title);
	const targetStyle = getComputedStyle(target);
	const fromWeight = Number.parseFloat(sourceStyle.fontWeight) || 400;
	const toWeight = Number.parseFloat(targetStyle.fontWeight) || 400;
	const fromSpacing = Number.parseFloat(sourceStyle.letterSpacing) || 0;
	const toSpacing = Number.parseFloat(targetStyle.letterSpacing) || 0;
	const original = {
		width: title.style.width,
		height: title.style.height,
		fontWeight: title.style.fontWeight,
		letterSpacing: title.style.letterSpacing,
	};
	const line = title.querySelector<HTMLElement>(".truncate");
	const lineWidth = line?.getBoundingClientRect().width ?? 0;
	const originalLineWidth = line?.style.width ?? "";
	const targetLineWidth = target.getBoundingClientRect().width / scale;
	// Cover/edit labels use fixed typography and padding in both players.
	// Counter-scale those lengths so the labels do not grow at the handoff.
	const fixedProperties = [
		"fontSize",
		"lineHeight",
		"letterSpacing",
		"paddingLeft",
		"paddingRight",
		"paddingTop",
		"paddingBottom",
		"borderWidth",
		"borderRadius",
		"marginRight",
	] as const;
	const targetLabels = target.querySelectorAll<HTMLElement>(
		"[data-motion-fixed]",
	);
	const labels = Array.from(
		title.querySelectorAll<HTMLElement>("[data-motion-fixed]"),
	).flatMap((element, index) => {
		const counterpart = targetLabels[index];
		if (!counterpart) return [];
		const from = getComputedStyle(element);
		const to = getComputedStyle(counterpart);
		const properties = fixedProperties.map((property) => ({
			property,
			original: element.style[property],
			from: Number.parseFloat(from[property]) || 0,
			to: Number.parseFloat(to[property]) || 0,
		}));
		// Borders round to device pixels, unlike padding. Preserve the label's
		// full box when a fractional inverse-scaled border gets rounded down.
		const border = properties.find((value) => value.property === "borderWidth");
		if (!border) return [];
		element.style.borderWidth = `${border.to / scale}px`;
		const paintedBorder =
			Number.parseFloat(getComputedStyle(element).borderTopWidth) || 0;
		element.style.borderWidth = border.original;
		const paddingCorrection = border.to - paintedBorder * scale;
		return [
			{
				element,
				paddingCorrection,
				properties,
			},
		];
	});
	// Changing tracking would otherwise resize this centered flex item and
	// shift its transform origin while it travels toward the footer.
	const box = title.getBoundingClientRect();
	title.style.width = `${box.width}px`;
	title.style.height = `${box.height}px`;
	return {
		apply: (progress: number) => {
			if (line)
				line.style.width = `${lineWidth + (targetLineWidth - lineWidth) * progress}px`;
			title.style.fontWeight = String(
				fromWeight + (toWeight - fromWeight) * progress,
			);
			title.style.letterSpacing = `${scaledLengthAtProgress(
				fromSpacing,
				toSpacing,
				scale,
				progress,
			)}px`;
			for (const { element, properties, paddingCorrection } of labels)
				for (const value of properties)
					element.style[value.property] =
						`${scaledLengthAtProgress(value.from, value.to + (value.property.startsWith("padding") ? paddingCorrection : 0), scale, progress)}px`;
		},
		release: () => {
			Object.assign(title.style, original);
			if (line) line.style.width = originalLineWidth;
			for (const { element, properties } of labels)
				for (const value of properties)
					element.style[value.property] = value.original;
		},
	};
}

/** Translation about a wrapper's top-left that aligns the visible contents. */
export function projectPlayerItem(
	origin: MotionRect,
	source: MotionRect,
	target: MotionRect,
	scale: number,
	align: "center" | "start" = "center",
) {
	const anchor = align === "start" ? 0 : 0.5;
	return {
		x:
			target.x +
			target.width * anchor -
			origin.x -
			scale * (source.x + source.width * anchor - origin.x),
		y:
			target.y +
			target.height / 2 -
			origin.y -
			scale * (source.y + source.height / 2 - origin.y),
	};
}

/** Ranges include clipped text; constrain their geometry to the painted line. */
export function clipTextRect(text: MotionRect, clip: MotionRect): MotionRect {
	const x = Math.max(text.x, clip.x);
	const y = Math.max(text.y, clip.y);
	return {
		x,
		y,
		width: Math.max(0, Math.min(text.x + text.width, clip.x + clip.width) - x),
		height: Math.max(
			0,
			Math.min(text.y + text.height, clip.y + clip.height) - y,
		),
	};
}

/** Measure the inline contents, not a full-width block row in the Range. */
export function textRect(element: Element): DOMRect {
	const content = element.querySelector("[data-motion-text]") ?? element;
	const range = document.createRange();
	range.selectNodeContents(content);
	const rect = range.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0)
		return content.getBoundingClientRect();
	const clip = (
		content.closest(".truncate") ?? content
	).getBoundingClientRect();
	const painted = clipTextRect(rect, clip);
	return new DOMRect(painted.x, painted.y, painted.width, painted.height);
}
