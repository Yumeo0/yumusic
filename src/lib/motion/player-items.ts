/** Remaining player elements, paired separately so metadata never travels as
 * part of a differently sized title/artist block. Missing targets fade downward. */
export const PLAYER_SECONDARY_PAIRS = [
	{ selector: "[data-np-album]", target: "[data-mini-album]", text: true },
	{ selector: "[data-np-download]", target: "[data-mini-download]" },
	{ selector: "[data-np-repeat]", target: "[data-mini-repeat]" },
	{ selector: "[data-np-volume]", target: "[data-mini-volume]" },
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
