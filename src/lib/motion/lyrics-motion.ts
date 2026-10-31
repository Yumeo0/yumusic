import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
} from "react";
import { textRect } from "@/lib/motion/queue-drag";
import { PLAYER_SECONDARY_PAIRS } from "./player-items";

/** Matches Tailwind's max-md breakpoint: the lyrics toggle is mobile-only. */
const MOBILE_QUERY = "(max-width: 767.98px)";
/** Same travel time and ease-out-cubic curve as the fullscreen open/close. */
const DURATION = 300;
const EASING = "cubic-bezier(0.33, 1, 0.68, 1)";

/**
 * Elements shared by both mobile layouts (morphing stage vs compact lyrics
 * row). Each is a different DOM node per layout; they are paired by selector,
 * picking whichever instance is currently visible. Text lines are matched by
 * their glyph box, since alignment differs (centered vs left).
 */
const PAIRS: { selector: string; text?: boolean; scale?: boolean }[] = [
	{ scale: true, selector: "[data-np-cover]" },
	{ selector: "[data-np-title-line]", text: true },
	{ selector: "[data-np-artist-line]", text: true },
	{ selector: "[data-np-seek-bar]" },
	{ selector: "[data-np-seek-times]" },
	{ selector: "[data-np-prev]" },
	{ selector: "[data-np-play]" },
	{ selector: "[data-np-next]" },
	{ selector: "[data-np-lyrics]" },
	{ selector: "[data-np-queue-pill]" },
	...PLAYER_SECONDARY_PAIRS.map((entry) => ({
		selector: entry.selector,
		text: "text" in entry && entry.text,
	})),
];

interface Snapshot {
	rects: Map<string, DOMRect>;
	coverRadius: number;
	/** Lyrics section box relative to its offset parent, for the exit fade. */
	section: { left: number; top: number; width: number; height: number } | null;
}

function visible(root: ParentNode, selector: string): HTMLElement | null {
	return (
		Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
			(element) => element.getBoundingClientRect().width > 0,
		) ?? null
	);
}

function measure(element: HTMLElement, text?: boolean): DOMRect {
	return text
		? textRect(element.querySelector("[data-motion-text]") ?? element)
		: element.getBoundingClientRect();
}

/** The cover's rounded element: the box itself or its first rounded child. */
function roundedElement(cover: HTMLElement): HTMLElement | null {
	for (const element of [cover, ...cover.querySelectorAll<HTMLElement>("*")]) {
		if (Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) > 0)
			return element;
	}
	return null;
}

function radiusOf(cover: HTMLElement | null): number {
	const element = cover && roundedElement(cover);
	return element
		? Number.parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0
		: 0;
}

function capture(page: HTMLElement): Snapshot {
	const rects = new Map<string, DOMRect>();
	for (const { selector, text } of PAIRS) {
		const element = visible(page, selector);
		if (element) rects.set(selector, measure(element, text));
	}
	let section: Snapshot["section"] = null;
	const sectionEl = page.querySelector<HTMLElement>("[data-np-lyrics-section]");
	const parent = sectionEl?.offsetParent;
	if (sectionEl && parent) {
		const rect = sectionEl.getBoundingClientRect();
		const parentRect = parent.getBoundingClientRect();
		if (rect.width > 0)
			section = {
				height: rect.height,
				left: rect.left - parentRect.left - parent.clientLeft,
				top: rect.top - parentRect.top - parent.clientTop,
				width: rect.width,
			};
	}
	return {
		coverRadius: radiusOf(visible(page, "[data-np-cover]")),
		rects,
		section,
	};
}

/**
 * Animates the mobile lyrics toggle: artwork, title, seek bar and transport
 * glide (FLIP) from their old layout onto the new one, while the lyrics
 * section fades in from above or fades out in place under the growing cover.
 *
 * Returns `prepare`, which must be called right before the state flips so the
 * old layout can be measured. Desktop always shows lyrics, so it is a no-op
 * there.
 */
export function useLyricsMorph(
	pageRef: RefObject<HTMLElement | null>,
	showLyrics: boolean,
) {
	const snapshot = useRef<Snapshot | null>(null);
	const running = useRef<Animation[]>([]);
	const cleanup = useRef<(() => void) | null>(null);

	const stop = useCallback(() => {
		for (const animation of running.current) animation.cancel();
		running.current = [];
		cleanup.current?.();
		cleanup.current = null;
	}, []);

	const prepare = useCallback(() => {
		const page = pageRef.current;
		if (
			!page ||
			!window.matchMedia(MOBILE_QUERY).matches ||
			window.matchMedia("(prefers-reduced-motion: reduce)").matches
		) {
			snapshot.current = null;
			stop();
			return;
		}
		// Measure first: mid-flight positions make a re-toggle reverse smoothly.
		snapshot.current = capture(page);
		stop();
		// Keep the nested `.np-morph` transitions from easing the freshly
		// mounted layout into place (measured metrics are written on mount).
		page.dataset.npLyricsMorph = "true";
	}, [pageRef, stop]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs per toggle
	useLayoutEffect(() => {
		const page = pageRef.current;
		const from = snapshot.current;
		snapshot.current = null;
		if (!page || !from) return;

		try {
			// The remounted artwork/title would replay their track-change
			// entrance; they are glided into place instead.
			for (const element of page.querySelectorAll(".animate-track-in")) {
				for (const animation of element.getAnimations()) {
					if (
						typeof CSSAnimation !== "undefined" &&
						animation instanceof CSSAnimation
					)
						animation.finish();
				}
			}

			const animations: Animation[] = [];
			const timing: KeyframeAnimationOptions = {
				duration: DURATION,
				easing: EASING,
			};

			for (const { selector, text, scale } of PAIRS) {
				const element = visible(page, selector);
				const old = from.rects.get(selector);
				if (!element || !old) continue;
				const next = measure(element, text);
				if (next.width <= 0 || next.height <= 0) continue;
				const s = scale ? old.width / next.width : 1;
				const dx = old.left - next.left;
				const dy = old.top - next.top;
				if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(s - 1) < 0.01)
					continue;
				animations.push(
					element.animate(
						[
							{
								transform: `translate(${dx}px, ${dy}px) scale(${s})`,
								transformOrigin: "0 0",
							},
							{ transform: "none", transformOrigin: "0 0" },
						],
						timing,
					),
				);
				// Counter-scale the corner radius so the artwork keeps its
				// rounding instead of ballooning/flattening with the scale.
				if (scale && s !== 1) {
					const rounded = roundedElement(element);
					if (rounded) {
						const radius = getComputedStyle(rounded).borderTopLeftRadius;
						animations.push(
							rounded.animate(
								[
									{ borderRadius: `${from.coverRadius / s}px` },
									{ borderRadius: radius },
								],
								timing,
							),
						);
					}
				}
			}

			// The stage's glow is pinned to the final cover: fade it in as the
			// artwork grows into it.
			const glow = visible(page, "[data-np-cover-glow]");
			if (glow && !showLyrics) {
				animations.push(
					glow.animate(
						[{ opacity: 0 }, { opacity: getComputedStyle(glow).opacity }],
						timing,
					),
				);
			}

			const section = page.querySelector<HTMLElement>(
				"[data-np-lyrics-section]",
			);
			if (section && showLyrics) {
				animations.push(
					section.animate(
						[
							{ opacity: 0, transform: "translateY(-16px)" },
							{ opacity: 1, transform: "none" },
						],
						{ ...timing, delay: 60, fill: "backwards" },
					),
				);
			} else if (section && from.section) {
				// Keep the outgoing lyrics on screen, out of flow at their old
				// box, while they fade under the cover growing over them.
				const { left, top, width, height } = from.section;
				Object.assign(section.style, {
					display: "flex",
					height: `${height}px`,
					left: `${left}px`,
					margin: "0",
					pointerEvents: "none",
					position: "absolute",
					top: `${top}px`,
					width: `${width}px`,
				});
				const restore = () => {
					for (const property of [
						"display",
						"height",
						"left",
						"margin",
						"pointer-events",
						"position",
						"top",
						"width",
					])
						section.style.removeProperty(property);
				};
				const fade = section.animate(
					[
						{ opacity: 1, transform: "none" },
						{ opacity: 0, transform: "translateY(-16px)" },
					],
					{ duration: 200, easing: EASING, fill: "forwards" },
				);
				animations.push(fade);
				cleanup.current = restore;
				fade.finished
					.then(() => {
						if (cleanup.current !== restore) return;
						cleanup.current = null;
						restore();
						fade.cancel();
					})
					.catch(() => undefined); // cancelled: superseded by a re-toggle
			}

			running.current = animations;
			for (const animation of animations) {
				animation.finished
					.then(() => {
						running.current = running.current.filter((a) => a !== animation);
					})
					.catch(() => undefined); // cancelled: superseded by a re-toggle
			}
		} finally {
			delete page.dataset.npLyricsMorph;
		}
	}, [showLyrics]);

	useEffect(() => stop, [stop]);

	return prepare;
}
