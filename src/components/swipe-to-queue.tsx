import { ListPlus } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface SwipeToQueueProps {
	children: React.ReactNode;
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
export function SwipeToQueue({ children, onQueue }: SwipeToQueueProps) {
	const [drag, setDrag] = useState(0);
	const [queued, setQueued] = useState(false);
	const start = useRef<{ x: number; y: number } | null>(null);
	const axis = useRef<"horizontal" | "vertical" | null>(null);

	const handleTouchStart = (event: React.TouchEvent) => {
		const touch = event.touches[0];
		if (!touch) return;
		start.current = { x: touch.clientX, y: touch.clientY };
		axis.current = null;
	};

	const handleTouchMove = (event: React.TouchEvent) => {
		const touch = event.touches[0];
		const origin = start.current;
		if (!touch || !origin) return;
		const dx = touch.clientX - origin.x;
		const dy = touch.clientY - origin.y;
		if (!axis.current) {
			if (Math.abs(dx) < DRAG_START_SLOP && Math.abs(dy) < DRAG_START_SLOP) {
				return;
			}
			// Lock to one axis so vertical list scrolling is never hijacked
			axis.current = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
		}
		if (axis.current === "horizontal") {
			setDrag(Math.max(0, Math.min(dx, MAX_DRAG)));
		}
	};

	const handleTouchEnd = () => {
		start.current = null;
		axis.current = null;
		if (drag >= QUEUE_THRESHOLD) {
			onQueue();
			setQueued(true);
			window.setTimeout(() => setQueued(false), 1200);
			if (typeof navigator.vibrate === "function") {
				navigator.vibrate(15);
			}
		}
		setDrag(0);
	};

	return (
		<div className="cv-row relative overflow-hidden">
			<span
				aria-hidden
				className="absolute top-1/2 left-3.5 -translate-y-1/2 text-primary transition-opacity duration-100"
				style={{ opacity: Math.min(drag / QUEUE_THRESHOLD, 1) }}
			>
				<ListPlus className="size-5" />
			</span>
			<div
				className={cn(
					"relative touch-pan-y",
					queued && "bg-primary/10 transition-colors duration-300",
				)}
				onTouchEnd={handleTouchEnd}
				onTouchMove={handleTouchMove}
				onTouchStart={handleTouchStart}
				style={{
					transform: `translateX(${drag}px)`,
					// Only the row under the finger is promoted to its own
					// compositor layer; setting `will-change` on every row in a
					// long playlist forces hundreds of layers and tanks hover and
					// scroll performance.
					willChange: drag > 0 ? "transform" : undefined,
				}}
			>
				{children}
			</div>
		</div>
	);
}
