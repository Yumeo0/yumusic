import { ListPlus } from "@lucide/solid";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { cn } from "@/lib/utils/utils";

interface SwipeToQueueProps {
	children: JSX.Element;
	/** Called when the row is released past the swipe threshold */
	onQueue: () => void;
}

const QUEUE_THRESHOLD = 80;
const MAX_DRAG = 112;
const DRAG_START_SLOP = 8;

/**
 * Spotify-style gesture wrapper for track rows: dragging the row to the
 * right past the threshold adds it to the queue, with a hint icon fading
 * in underneath and a brief highlight + haptic tick on success.
 * Touch-only — mouse users keep the plain row — and vertical scrolling
 * stays native via `touch-action: pan-y`.
 */
export function SwipeToQueue(props: SwipeToQueueProps) {
	const [drag, setDrag] = createSignal(0);
	const [queued, setQueued] = createSignal(false);
	let start: { x: number; y: number } | null = null;
	let axis: "horizontal" | "vertical" | null = null;

	const handleTouchStart = (event: TouchEvent) => {
		const touch = event.touches[0];
		if (!touch) return;
		start = { x: touch.clientX, y: touch.clientY };
		axis = null;
	};

	const handleTouchMove = (event: TouchEvent) => {
		const touch = event.touches[0];
		const origin = start;
		if (!touch || !origin) return;
		const dx = touch.clientX - origin.x;
		const dy = touch.clientY - origin.y;
		if (!axis) {
			if (Math.abs(dx) < DRAG_START_SLOP && Math.abs(dy) < DRAG_START_SLOP) {
				return;
			}
			// Lock to one axis so vertical list scrolling is never hijacked
			axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
		}
		if (axis === "horizontal") {
			setDrag(Math.max(0, Math.min(dx, MAX_DRAG)));
		}
	};

	const handleTouchEnd = () => {
		start = null;
		axis = null;
		if (drag() >= QUEUE_THRESHOLD) {
			props.onQueue();
			setQueued(true);
			window.setTimeout(() => setQueued(false), 1200);
			if (typeof navigator.vibrate === "function") {
				navigator.vibrate(15);
			}
		}
		setDrag(0);
	};

	return (
		<div class="cv-row relative overflow-hidden">
			<span
				aria-hidden="true"
				class="absolute top-1/2 left-3.5 -translate-y-1/2 text-primary transition-opacity duration-100"
				style={{ opacity: Math.min(drag() / QUEUE_THRESHOLD, 1) }}
			>
				<ListPlus class="size-5" />
			</span>
			<div
				class={cn(
					"relative touch-pan-y",
					queued() && "bg-primary/10 transition-colors duration-300",
				)}
				onTouchEnd={handleTouchEnd}
				onTouchMove={handleTouchMove}
				onTouchStart={handleTouchStart}
				style={{
					transform: `translateX(${drag()}px)`,
					// Only the row under the finger is promoted to its own
					// compositor layer; setting `will-change` on every row in a
					// long playlist forces hundreds of layers and tanks hover and
					// scroll performance.
					"will-change": drag() > 0 ? "transform" : undefined,
				}}
			>
				{props.children}
			</div>
		</div>
	);
}
