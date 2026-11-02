import { type RefObject, type TouchEvent, useEffect, useRef } from "react";
import { getNowPlayingOpen, getQueueOpen } from "@/lib/player/player-ui";
import { haptic } from "@/lib/utils/haptics";

/** Horizontal track changes share axis locking with the vertical player gesture. */
export function useMiniPlayerTrackSwipe({
	trackRef,
	enabled,
	hasNext,
	hasPrevious,
	next,
	previous,
}: {
	trackRef: RefObject<HTMLDivElement | null>;
	enabled: boolean;
	hasNext: boolean;
	hasPrevious: boolean;
	next: () => void;
	previous: () => void;
}) {
	const gesture = useRef<{
		x: number;
		y: number;
		distance: number;
		following: boolean;
	} | null>(null);
	const suppressClick = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);
	const finish = (event: TouchEvent, cancelled: boolean) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current?.following) return;
		event.preventDefault();
		const node = trackRef.current;
		if (node) {
			node.dataset.swipeContextUntil = String(performance.now() + 700);
			node.style.transition = window.matchMedia(
				"(prefers-reduced-motion: reduce)",
			).matches
				? "none"
				: "translate 280ms cubic-bezier(.2,1.4,.4,1), opacity 180ms ease";
			node.style.translate = "0px";
			node.style.opacity = "1";
		}
		if (!cancelled && Math.abs(current.distance) >= 64) {
			if (current.distance < 0 && hasNext) {
				haptic("confirm");
				next();
			} else if (current.distance > 0 && hasPrevious) {
				haptic("confirm");
				previous();
			}
		}
		timer.current = setTimeout(() => {
			suppressClick.current = false;
			node?.style.removeProperty("transition");
			node?.style.removeProperty("translate");
			node?.style.removeProperty("opacity");
		}, 350);
	};
	return {
		onTouchStartCapture: (event: TouchEvent) => {
			gesture.current = null;
			suppressClick.current = false;
			if (timer.current) clearTimeout(timer.current);
			const node = trackRef.current;
			node?.style.removeProperty("transition");
			node?.style.removeProperty("translate");
			node?.style.removeProperty("opacity");
			if (
				!enabled ||
				event.touches.length !== 1 ||
				getNowPlayingOpen() ||
				getQueueOpen() ||
				!window.matchMedia("(max-width: 767.98px)").matches
			)
				return;
			if (
				event.target instanceof Element &&
				event.target.closest(
					'.player-ctl, [data-swipe-dismiss-ignore], [role="slider"], input',
				)
			)
				return;
			const touch = event.touches[0];
			if (!node || touch.clientY < node.getBoundingClientRect().top) return;
			node.dataset.swipeContextUntil = "0";
			gesture.current = {
				x: touch.clientX,
				y: touch.clientY,
				distance: 0,
				following: false,
			};
		},
		onTouchMoveCapture: (event: TouchEvent) => {
			const current = gesture.current;
			if (!current) return;
			if (event.touches.length !== 1) {
				finish(event, true);
				return;
			}
			const dx = event.touches[0].clientX - current.x;
			const dy = event.touches[0].clientY - current.y;
			if (!current.following) {
				if (Math.abs(dy) > Math.max(10, Math.abs(dx))) {
					gesture.current = null;
					return;
				}
				if (Math.abs(dx) <= Math.max(10, Math.abs(dy))) return;
				current.following = true;
				suppressClick.current = true;
			}
			current.distance = dx;
			const node = trackRef.current;
			if (node) {
				node.dataset.swipeContextUntil = "Infinity";
				const allowed = dx < 0 ? hasNext : hasPrevious;
				node.style.translate = `${Math.sign(dx) * Math.min(64, Math.abs(dx) * (allowed ? 0.45 : 0.12))}px`;
				node.style.opacity = String(1 - Math.min(0.25, Math.abs(dx) / 400));
			}
		},
		onTouchEndCapture: (event: TouchEvent) => finish(event, false),
		onTouchCancelCapture: (event: TouchEvent) => finish(event, true),
		onClickCapture: (event: React.MouseEvent) => {
			if (suppressClick.current) {
				event.preventDefault();
				event.stopPropagation();
			}
		},
	};
}
