import { useRef } from "react";
import { useQueueSheetRef } from "@/contexts/player-context";
import {
	getQueueOpen,
	getQueueState,
	type QueueState,
	setQueueReveal,
	setQueueState,
} from "@/lib/player-ui";

/**
 * Queue sheet resting offsets, as a fraction of its height: "full" shows the
 * whole sheet, "half" leaves it peeking over the bottom half of the screen,
 * and "closed" parks it below the viewport.
 */
const QUEUE_DETENTS: Record<QueueState, number> = {
	full: 0,
	half: 0.5,
	closed: 1,
};
/** Detents, most to least open: drag steps move along this order. */
const QUEUE_ORDER: QueueState[] = ["full", "half", "closed"];
/** Finger travel from the touch start that, on release, moves one detent. */
const SNAP_DISTANCE = 64;
/** Finger must travel this far before the sheet starts following. */
const DRAG_START_SLOP = 10;
/** Matches Tailwind's max-md breakpoint; the sheet gestures are mobile-only. */
const MOBILE_QUERY = "(max-width: 767.98px)";
/** Duration of the CSS snap animation on the sheet (see queue-panel). */
const SNAP_DURATION_MS = 300;

/** Whether the swipe gestures (which mirror the mobile sheet layouts) apply. */
function isMobile() {
	return window.matchMedia(MOBILE_QUERY).matches;
}

/**
 * Marks the document as mid morph-drag: morphing layouts read this to skip
 * their easing while the finger drives them (see the `.np-morph` rule in
 * globals.css). Cleared on release so the snap to the target animates.
 */
function setMorphDragging(dragging: boolean) {
	if (dragging) {
		document.documentElement.dataset.morphDragging = "true";
	} else {
		delete document.documentElement.dataset.morphDragging;
	}
}

/**
 * The detent a release lands on. The distance travelled from where the touch
 * started decides — not where the sheet happens to sit relative to its
 * detents — so a short flick moves the sheet even though it has only visibly
 * moved a little. A drag of at least SNAP_DISTANCE moves exactly one detent
 * in that direction; anything shorter snaps back to rest. Reaching the far
 * detent takes another drag.
 */
function detentAfterDrag(resting: QueueState, upDistance: number): QueueState {
	if (Math.abs(upDistance) < SNAP_DISTANCE) return resting;
	const index = QUEUE_ORDER.indexOf(resting) + (upDistance > 0 ? -1 : 1);
	return QUEUE_ORDER[Math.min(Math.max(index, 0), QUEUE_ORDER.length - 1)];
}

/**
 * Animates a dragged sheet to its resting offset, then hands control back to
 * the CSS classes (which resolve to the same position, so nothing jumps when
 * the inline styles are removed). Returns the timer so callers can cancel a
 * pending settle when a new drag starts.
 */
function settleSheet(
	element: HTMLElement,
	translateY: number,
	opacity = 1,
): number {
	element.style.transition = `translate ${SNAP_DURATION_MS}ms ease-out, opacity ${SNAP_DURATION_MS}ms ease-out`;
	element.style.translate = `0 ${translateY}px`;
	element.style.opacity = String(opacity);
	element.getBoundingClientRect();
	return window.setTimeout(() => {
		element.style.transition = "";
		element.style.translate = "";
		element.style.opacity = "";
	}, SNAP_DURATION_MS + 20);
}

/** Optional predicate a queue gesture consults before taking a touch. */
export type QueueGestureCheck = (event: React.TouchEvent) => boolean;

/** Touch handlers a queue gesture exposes; they can be spread on one element. */
export interface TouchHandlers {
	onTouchCancel: (event: React.TouchEvent) => void;
	onTouchEnd: (event: React.TouchEvent) => void;
	onTouchMove: (event: React.TouchEvent) => void;
	onTouchStart: (event: React.TouchEvent) => void;
}

/**
 * Runs several gesture handler sets for the same touch, in the order given —
 * so one element can host the opening gesture and the sheet-dragging gesture
 * at once (only one of them accepts a given touch, based on the queue state).
 */
export function mergeTouchHandlers(...sets: TouchHandlers[]): TouchHandlers {
	const run = (event: React.TouchEvent, key: keyof TouchHandlers) => {
		for (const set of sets) set[key](event);
	};
	return {
		onTouchCancel: (event) => run(event, "onTouchCancel"),
		onTouchEnd: (event) => run(event, "onTouchEnd"),
		onTouchMove: (event) => run(event, "onTouchMove"),
		onTouchStart: (event) => run(event, "onTouchStart"),
	};
}

/**
 * Swipe-up gesture that progressively reveals the queue sheet from below: the
 * sheet follows the finger 1:1 (written through the shared ref, no
 * re-renders); on release a drag of SNAP_DISTANCE opens it to the half
 * detent, and anything shorter closes again. A further drag from half reaches
 * full. It applies whenever the queue is closed, from anywhere on the page;
 * `canStart` can exclude regions (e.g. the scrollable lyrics).
 */
export function useQueueDragGesture(canStart?: QueueGestureCheck) {
	const sheetRef = useQueueSheetRef();
	const startY = useRef<number | null>(null);
	const following = useRef(false);
	const upDistance = useRef(0);
	const snapTimer = useRef<number | null>(null);
	const canStartRef = useRef(canStart);
	canStartRef.current = canStart;

	const finish = (state: QueueState) => {
		startY.current = null;
		following.current = false;
		setMorphDragging(false);
		setQueueState(state);
		// setQueueState is a no-op when the state is unchanged (e.g. a short
		// drag released back to the same detent), but the drag left the blend
		// mid-way — re-snap it to the detent so the layout eases back.
		setQueueReveal(state === "closed" ? 0 : 1);
		const sheet = sheetRef?.current;
		if (!sheet) return;
		// Tailwind's translate-y-* utilities drive the CSS `translate`
		// property, so the inline animation must target that property.
		if (snapTimer.current !== null) window.clearTimeout(snapTimer.current);
		const height = sheet.offsetHeight || window.innerHeight;
		snapTimer.current = settleSheet(sheet, QUEUE_DETENTS[state] * height);
	};

	const onTouchStart = (event: React.TouchEvent) => {
		const touch = event.touches[0];
		if (!touch || getQueueOpen()) return;
		if (!isMobile()) return;
		if (canStartRef.current && !canStartRef.current(event)) return;
		startY.current = touch.clientY;
		following.current = false;
		upDistance.current = 0;
	};

	const onTouchMove = (event: React.TouchEvent) => {
		if (startY.current === null) return;
		const touch = event.touches[0];
		if (!touch) return;
		const delta = startY.current - touch.clientY;
		if (!following.current) {
			if (delta < DRAG_START_SLOP) return;
			following.current = true;
			// Freeze the page morph before the state flips, so the layout
			// tracks the finger from the first frame instead of easing open.
			setMorphDragging(true);
			// Reflect the revealed queue immediately (not only on release) so
			// the now-playing layout can move its controls out of the way while
			// the sheet is still following the finger.
			setQueueState("half");
			const sheet = sheetRef?.current;
			if (snapTimer.current !== null) {
				window.clearTimeout(snapTimer.current);
				snapTimer.current = null;
			}
			if (sheet) sheet.style.transition = "none";
		}
		upDistance.current = delta;
		const sheet = sheetRef?.current;
		if (!sheet) return;
		const height = sheet.offsetHeight || window.innerHeight;
		// 1:1 with the finger: the sheet rests one full height below the
		// screen and rises by exactly the distance travelled.
		const offset = Math.min(Math.max(height - delta, 0), height);
		// Feed the layout blend so the page morphs along with the finger.
		setQueueReveal((1 - offset / height) * 2);
		if (offset === 0) {
			finish("full");
			return;
		}
		sheet.style.translate = `0 ${offset}px`;
	};

	const onTouchEnd = () => {
		if (startY.current === null) return;
		if (!following.current) {
			startY.current = null;
			return;
		}
		finish(detentAfterDrag("closed", upDistance.current));
	};

	return {
		onTouchCancel: onTouchEnd,
		onTouchEnd,
		onTouchMove,
		onTouchStart,
	};
}

/**
 * Drag gesture for the open queue sheet: it follows the finger in both
 * directions between the full, half and closed detents. On release the finger
 * travel from where the touch started decides (see detentAfterDrag), so a
 * short flick moves it a whole detent either way. Used on the sheet's header
 * and on the now-playing page, where the area above the sheet's top edge acts
 * as a handle; `canStart` can exclude regions (e.g. the scrollable lyrics).
 * Mobile-only, like the opening gesture it mirrors.
 */
export function useQueueSheetGesture(canStart?: QueueGestureCheck) {
	const sheetRef = useQueueSheetRef();
	const startY = useRef<number | null>(null);
	const restingOffset = useRef(0);
	const restingState = useRef<QueueState>("closed");
	const upDistance = useRef(0);
	const following = useRef(false);
	const snapTimer = useRef<number | null>(null);
	const canStartRef = useRef(canStart);
	canStartRef.current = canStart;

	const finish = (state: QueueState) => {
		startY.current = null;
		following.current = false;
		// Re-enable the morph's easing before the state flips so the snap
		// animates; the explicit reveal write covers releases that land on
		// the detent the state already holds.
		setMorphDragging(false);
		setQueueState(state);
		setQueueReveal(state === "closed" ? 0 : 1);
		const sheet = sheetRef?.current;
		if (!sheet) return;
		if (snapTimer.current !== null) window.clearTimeout(snapTimer.current);
		const height = sheet.offsetHeight || window.innerHeight;
		snapTimer.current = settleSheet(sheet, QUEUE_DETENTS[state] * height);
	};

	const onTouchStart = (event: React.TouchEvent) => {
		const touch = event.touches[0];
		if (!touch || !getQueueOpen()) return;
		if (!isMobile()) return;
		if (canStartRef.current && !canStartRef.current(event)) return;
		const sheet = sheetRef?.current;
		if (!sheet) return;
		const height = sheet.offsetHeight || window.innerHeight;
		restingState.current = getQueueState();
		restingOffset.current = QUEUE_DETENTS[restingState.current] * height;
		upDistance.current = 0;
		startY.current = touch.clientY;
		following.current = false;
	};

	const onTouchMove = (event: React.TouchEvent) => {
		if (startY.current === null) return;
		const touch = event.touches[0];
		if (!touch) return;
		const delta = touch.clientY - startY.current;
		if (!following.current) {
			if (Math.abs(delta) < DRAG_START_SLOP) return;
			following.current = true;
			// Freeze the morph easing while the finger drives the sheet.
			setMorphDragging(true);
			const sheet = sheetRef?.current;
			if (snapTimer.current !== null) {
				window.clearTimeout(snapTimer.current);
				snapTimer.current = null;
			}
			if (sheet) sheet.style.transition = "none";
		}
		upDistance.current = -delta;
		const sheet = sheetRef?.current;
		if (!sheet) return;
		const height = sheet.offsetHeight || window.innerHeight;
		const offset = Math.min(Math.max(restingOffset.current + delta, 0), height);
		// Feed the layout blend so the page follows the sheet both ways.
		setQueueReveal((1 - offset / height) * 2);
		sheet.style.translate = `0 ${offset}px`;
	};

	const onTouchEnd = () => {
		if (startY.current === null) return;
		if (!following.current) {
			startY.current = null;
			return;
		}
		finish(detentAfterDrag(restingState.current, upDistance.current));
	};

	return {
		onTouchCancel: onTouchEnd,
		onTouchEnd,
		onTouchMove,
		onTouchStart,
	};
}

/** Where the dismiss morph sends everything, measured at drag start. */
export interface DismissGeometry {
	page: HTMLElement | null;
	/** Finger travel that moves the artwork onto the mini-player thumbnail. */
	travel: number;
	/** Full page height: the overlay slides this far to be fully off-screen. */
	height: number;
}

/** Tight box of an element's text, falling back to its border box. */
export function textRect(element: Element): DOMRect {
	const range = document.createRange();
	range.selectNodeContents(element);
	const rect = range.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0
		? rect
		: element.getBoundingClientRect();
}

/** Font-size ratio between two elements (the scale a text morph needs). */
function fontScale(from: Element, to: Element): number {
	const source = Number.parseFloat(getComputedStyle(from).fontSize) || 0;
	const target = Number.parseFloat(getComputedStyle(to).fontSize) || 0;
	if (source <= 0 || target <= 0) return 1;
	return Math.min(target / source, 1);
}

/**
 * Measures the mini player's geometry and writes the dismiss-morph targets
 * onto the morphing stage: where the artwork, title, artist, seek bar and
 * transport must land, and how far the artwork travels to get there. The
 * element transforms interpolate linearly with `--np-dismiss` and are pinned
 * by `--np-slide` while the page itself slides away. Returns null when the
 * mini player is not materialized. Visible pairs are measured across the
 * whole page, including the compact lyrics layout and desktop layout.
 */
export function measureDismissGeometry(
	overlay: HTMLElement,
): DismissGeometry | null {
	const visible = (selector: string) =>
		Array.from(overlay.querySelectorAll<HTMLElement>(selector)).find(
			(element) => element.getBoundingClientRect().width > 0,
		) ?? null;
	const stage = visible("[data-np-morph-stage]");
	const cover = visible("[data-np-cover]");
	const thumb = document.querySelector<HTMLElement>("[data-mini-thumb]");
	if (!cover || !thumb) return null;

	const stageRect = (stage ?? overlay).getBoundingClientRect();
	const thumbRect = thumb.getBoundingClientRect();
	overlay.style.setProperty(
		"--np-min-cover-left",
		`${thumbRect.left - stageRect.left}px`,
	);
	overlay.style.setProperty(
		"--np-min-cover-top",
		`${thumbRect.top - stageRect.top}px`,
	);
	overlay.style.setProperty("--np-min-cover-size", `${thumbRect.width}px`);

	/**
	 * Writes the translate/scale pair that lands `source`'s center on
	 * `target`'s center: with `translate(t * d) scale(1 + (s - 1) * d)` about
	 * the wrapper's top-left, t = target - origin - s * (source - origin).
	 */
	const pair = (
		wrapper: Element | null,
		source: DOMRect | null,
		target: DOMRect | null,
		prefix: string,
		scale: number,
	) => {
		if (!wrapper || !source || !target) return;
		const origin = wrapper.getBoundingClientRect();
		const position = Math.min(Math.max(scale, 0.05), 1.5);
		const ax = source.x + source.width / 2 - origin.x;
		const ay = source.y + source.height / 2 - origin.y;
		overlay.style.setProperty(
			`${prefix}-tx`,
			`${target.x + target.width / 2 - origin.x - position * ax}px`,
		);
		overlay.style.setProperty(
			`${prefix}-ty`,
			`${target.y + target.height / 2 - origin.y - position * ay}px`,
		);
		overlay.style.setProperty(`${prefix}-s`, String(position));
	};

	if (!stage) {
		const rect = cover.getBoundingClientRect();
		pair(cover, rect, thumbRect, "--np-cover", thumbRect.width / rect.width);
	}

	const titleLine = visible("[data-np-title-line]");
	const title = titleLine?.firstElementChild ?? null;
	const miniTitle = document.querySelector("[data-mini-title-line]");
	if (title && miniTitle) {
		pair(
			titleLine,
			textRect(title),
			textRect(miniTitle),
			"--np-title",
			fontScale(title, miniTitle),
		);
	}

	const artistLine = visible("[data-np-artist-line]");
	const artist = artistLine?.firstElementChild ?? null;
	const miniArtist = document.querySelector("[data-mini-artist]");
	if (artist && miniArtist) {
		pair(
			artistLine,
			textRect(artist),
			textRect(miniArtist),
			"--np-artist",
			fontScale(artist, miniArtist),
		);
	}

	/**
	 * Morphs one fullscreen transport button onto its mini-player counterpart
	 * (per button, so Previous/Play/Next land on the exact mini positions
	 * instead of the row being scaled as a block, whose gaps differ).
	 */
	const control = (from: string, to: string, prefix: string) => {
		const source = visible(from);
		const target = document.querySelector(to);
		if (!source || !target) return;
		const a = source.getBoundingClientRect();
		const b = target.getBoundingClientRect();
		pair(source, a, b, prefix, b.height / Math.max(a.height, 1));
	};
	control("[data-np-prev]", "[data-mini-prev]", "--np-prev");
	control("[data-np-play]", "[data-mini-play]", "--np-play");
	control("[data-np-next]", "[data-mini-next]", "--np-next");

	const seek = visible("[data-np-seek-bar]");
	const miniProgress = document.querySelector("[data-mini-progress]");
	if (seek && miniProgress) {
		const source = seek.getBoundingClientRect();
		const target = miniProgress.getBoundingClientRect();
		pair(
			seek,
			source,
			target,
			"--np-seek",
			target.width / Math.max(source.width, 1),
		);
	}

	const coverRect = cover.getBoundingClientRect();
	const travel =
		thumbRect.top +
		thumbRect.height / 2 -
		(coverRect.top + coverRect.height / 2);
	const height = overlay.offsetHeight || window.innerHeight;
	return {
		height,
		page: overlay.querySelector<HTMLElement>("[data-np-page]"),
		travel: travel > 40 ? travel : height * 0.6,
	};
}
