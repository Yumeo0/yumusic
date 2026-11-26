import { ListEnd, ListStart, Trash2 } from "lucide-react";
import {
	type CSSProperties,
	type ReactNode,
	type TouchEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { usePlayer } from "@/contexts/player-context";
import { GestureVelocity, rubberband } from "@/lib/motion/spring";
import {
	allowSwipeContextMenu,
	isSwipeContextSuppressed,
	suppressSwipeContextMenu,
} from "@/lib/motion/swipe-context-menu";
import { useSpringOffset } from "@/lib/motion/use-spring-offset";
import type { Song } from "@/lib/music/song";
import {
	NEXT_THRESHOLD,
	type SwipeAction,
	swipeDetent,
} from "@/lib/player/swipe-action";
import { haptic } from "@/lib/utils/haptics";
import { cn } from "@/lib/utils/utils";

interface SwipeToQueueProps {
	children: ReactNode;
	song: Song;
	onQueue: () => void;
	onRemove?: () => void;
	className?: string;
	style?: CSSProperties;
}

/** Horizontal touch actions with two right-swipe detents; scrolling stays native. */
export function SwipeToQueue({
	children,
	song,
	onQueue,
	onRemove,
	className,
	style,
}: SwipeToQueueProps) {
	const { playNext } = usePlayer();
	const [drag, springTo, spring] = useSpringOffset();
	const row = useRef<HTMLDivElement>(null);
	const detent = useRef<SwipeAction>(null);
	const [action, setAction] = useState<SwipeAction>(null);
	const [direction, setDirection] = useState(1);
	const start = useRef<{
		x: number;
		y: number;
		offset: number;
		velocity: GestureVelocity;
	} | null>(null);
	const axis = useRef<"horizontal" | "vertical" | null>(null);
	const suppressClick = useRef(false);
	const suppressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (suppressTimer.current) clearTimeout(suppressTimer.current);
		},
		[],
	);
	const finish = (cancelled: boolean) => {
		if (!start.current) return;
		const selected = detent.current;
		const velocity = cancelled ? 0 : start.current.velocity.read();
		start.current = null;
		axis.current = null;
		springTo(0, { velocity, momentum: !cancelled });
		if (suppressClick.current) suppressSwipeContextMenu(row.current);
		if (!cancelled && selected) {
			haptic("confirm");
			if (selected === "remove") onRemove?.();
			else if (selected === "queue") onQueue();
			else playNext(song);
		}
		if (suppressClick.current)
			suppressTimer.current = setTimeout(() => {
				suppressClick.current = false;
			}, 350);
	};
	const move = (event: TouchEvent) => {
		if (event.touches.length !== 1) {
			finish(true);
			return;
		}
		const touch = event.touches[0];
		const origin = start.current;
		if (!touch || !origin) return;
		if (
			event.target instanceof Element &&
			event.target.closest(".context-menu-highlight[data-popup-open]")
		) {
			finish(true);
			return;
		}
		const dx = touch.clientX - origin.x;
		const dy = touch.clientY - origin.y;
		if (!axis.current) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
			axis.current = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
		}
		if (axis.current !== "horizontal") return;
		suppressClick.current = true;
		const distance = origin.offset + dx;
		const lower = onRemove ? -104 : 0;
		const upper = 168;
		const next =
			distance < lower
				? lower + rubberband(distance - lower, 120)
				: distance > upper
					? upper + rubberband(distance - upper, 120)
					: distance;
		const selected = swipeDetent(next, detent.current, !!onRemove);
		if (selected !== detent.current) {
			haptic("tick");
			detent.current = selected;
			setAction(selected);
		}
		suppressSwipeContextMenu(row.current, true);
		setDirection(next < 0 ? -1 : 1);
		origin.velocity.add(next);
		spring.jump(next, origin.velocity.read());
	};
	const Icon =
		direction < 0 ? Trash2 : action === "queue" ? ListEnd : ListStart;
	const label =
		direction < 0
			? "Remove"
			: action === "queue"
				? "Add to queue"
				: "Play next";
	return (
		<div
			className={cn("cv-row relative overflow-hidden rounded-lg", className)}
			onContextMenuCapture={(event) => {
				if (isSwipeContextSuppressed(row.current)) {
					event.preventDefault();
					event.stopPropagation();
				}
			}}
			ref={row}
			style={style}
		>
			<span
				aria-hidden
				className={cn(
					"absolute inset-y-0 flex items-center gap-2 text-xs font-medium",
					direction < 0 ? "right-3 text-destructive" : "left-3 text-primary",
				)}
				style={{ opacity: Math.min(Math.abs(drag) / NEXT_THRESHOLD, 1) }}
			>
				<Icon className="size-5 shrink-0" />
				{action && Math.abs(drag) > 48 && <span>{label}</span>}
			</span>
			<div
				className={cn("relative touch-pan-y", drag !== 0 && "bg-background")}
				data-swipe-dismiss-ignore
				onClickCapture={(event) => {
					if (suppressClick.current) {
						event.preventDefault();
						event.stopPropagation();
					}
				}}
				onTouchCancelCapture={() => finish(true)}
				onTouchEndCapture={(event) => {
					// A removal unmounts this row: cancel the browser click too,
					// so it cannot land on the next row under the same finger.
					if (suppressClick.current) event.preventDefault();
					finish(false);
				}}
				onTouchMoveCapture={move}
				onTouchStartCapture={(event) => {
					if (event.touches.length !== 1) {
						finish(true);
						return;
					}
					const touch = event.touches[0];
					const velocity = new GestureVelocity();
					velocity.add(spring.position);
					start.current = {
						x: touch.clientX,
						y: touch.clientY,
						offset: spring.position,
						velocity,
					};
					spring.stop();
					axis.current = null;
					detent.current = null;
					setAction(null);
					allowSwipeContextMenu(row.current);
					suppressClick.current = false;
					if (suppressTimer.current) clearTimeout(suppressTimer.current);
				}}
				style={{
					transform: `translateX(${drag}px)`,
				}}
			>
				{children}
			</div>
		</div>
	);
}
