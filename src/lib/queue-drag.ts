import { useRef } from "react";
import { usePlayer, useQueueSheetRef } from "@/contexts/player-context";

/** Release opens the sheet once more than this fraction is revealed. */
const SNAP_OPEN_RATIO = 0.25;
/** Finger must travel this far up before the sheet starts following. */
const DRAG_START_SLOP = 10;
/** Matches Tailwind's max-md breakpoint; the sheet gesture is mobile-only. */
const MOBILE_QUERY = "(max-width: 767.98px)";
/** Duration of the CSS snap animation on the sheet (see queue-panel). */
const SNAP_DURATION_MS = 300;

/**
 * Swipe-up gesture that progressively reveals the queue sheet: while the
 * finger moves, the sheet's position follows it 1:1 (written through the
 * shared ref, no re-renders); on release it snaps open past the threshold,
 * closed below it. `isEligible` can restrict the gesture to touches
 * starting in a certain screen region (e.g. below the progress bar).
 */
export function useQueueDragGesture(isEligible?: (clientY: number) => boolean) {
	const { isQueueOpen, setQueueOpen } = usePlayer();
	const sheetRef = useQueueSheetRef();
	const startY = useRef<number | null>(null);
	const following = useRef(false);
	const progress = useRef(0);
	const snapTimer = useRef<number | null>(null);
	const eligibleFn = useRef(isEligible);
	eligibleFn.current = isEligible;

	const finish = (open: boolean) => {
		const sheet = sheetRef?.current;
		startY.current = null;
		following.current = false;
		progress.current = 0;
		setQueueOpen(open);
		if (!sheet) return;
		// Animate from the dragged position to the resting position, then
		// hand control back to the CSS classes (which resolve to the same
		// position, so nothing jumps when the inline styles are removed).
		// Tailwind's translate-y-* utilities drive the CSS `translate`
		// property, so the inline styles must target that property.
		if (snapTimer.current !== null) window.clearTimeout(snapTimer.current);
		sheet.style.transition = `translate ${SNAP_DURATION_MS}ms ease-out`;
		sheet.style.translate = open ? "0 0%" : `0 ${sheet.offsetHeight}px`;
		sheet.getBoundingClientRect();
		snapTimer.current = window.setTimeout(() => {
			sheet.style.transition = "";
			sheet.style.translate = "";
			snapTimer.current = null;
		}, SNAP_DURATION_MS + 20);
	};

	const onTouchStart = (event: React.TouchEvent) => {
		const touch = event.touches[0];
		if (!touch || isQueueOpen) return;
		if (!window.matchMedia(MOBILE_QUERY).matches) return;
		startY.current = touch.clientY;
		following.current = false;
		progress.current = 0;
	};

	const onTouchMove = (event: React.TouchEvent) => {
		if (startY.current === null) return;
		const touch = event.touches[0];
		if (!touch) return;
		const delta = startY.current - touch.clientY;
		if (!following.current) {
			if (delta < DRAG_START_SLOP) return;
			if (eligibleFn.current && !eligibleFn.current(startY.current)) {
				startY.current = null;
				return;
			}
			following.current = true;
			const sheet = sheetRef?.current;
			if (sheet) sheet.style.transition = "none";
		}
		const sheet = sheetRef?.current;
		if (!sheet) return;
		const height = sheet.offsetHeight || window.innerHeight;
		// 1:1 with the finger: the sheet rests one full height below the
		// screen and rises by exactly the distance travelled.
		const offset = Math.min(Math.max(height - delta, 0), height);
		progress.current = 1 - offset / height;
		if (offset === 0) {
			finish(true);
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
		finish(progress.current >= SNAP_OPEN_RATIO);
	};

	return {
		onTouchCancel: onTouchEnd,
		onTouchEnd,
		onTouchMove,
		onTouchStart,
	};
}
