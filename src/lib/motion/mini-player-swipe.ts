import { type RefObject, type TouchEvent, useEffect, useRef } from "react";
import { getNowPlayingOpen, getQueueOpen } from "@/lib/player/player-ui";
import { haptic } from "@/lib/utils/haptics";
import { MOBILE_QUERY } from "../utils/viewport";
import {
	createSpring,
	GestureVelocity,
	projectMomentum,
	rubberband,
} from "./spring";
import {
	allowSwipeContextMenu,
	suppressSwipeContextMenu,
} from "./swipe-context-menu";

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
	const springRef = useRef<ReturnType<typeof createSpring> | null>(null);
	if (!springRef.current)
		springRef.current = createSpring(0, (position) => {
			const node = trackRef.current;
			if (!node) return;
			node.style.translate = `${position}px`;
			node.style.opacity = String(1 - Math.min(0.25, Math.abs(position) / 400));
		});
	const spring = springRef.current;
	useEffect(() => () => spring.stop(), [spring]);
	const gesture = useRef<{
		x: number;
		y: number;
		origin: number;
		distance: number;
		following: boolean;
		velocity: GestureVelocity;
	} | null>(null);
	const suppressClick = useRef(false);
	const finish = (event: TouchEvent, cancelled: boolean) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current?.following) return;
		if (event.cancelable) event.preventDefault();
		const velocity = cancelled ? 0 : current.velocity.read();
		const projected = current.distance + projectMomentum(velocity);
		const node = trackRef.current;
		suppressSwipeContextMenu(node);
		spring.animate(0, { velocity, momentum: !cancelled });
		if (!cancelled && Math.abs(projected) >= 64) {
			if (projected < 0 && hasNext) {
				haptic("confirm");
				next();
			} else if (projected > 0 && hasPrevious) {
				haptic("confirm");
				previous();
			}
		}
	};
	return {
		onTouchStartCapture: (event: TouchEvent) => {
			gesture.current = null;
			suppressClick.current = false;
			if (
				!enabled ||
				event.touches.length !== 1 ||
				getNowPlayingOpen() ||
				getQueueOpen() ||
				!window.matchMedia(MOBILE_QUERY).matches
			)
				return;
			if (
				event.target instanceof Element &&
				event.target.closest(
					'.player-ctl, [data-swipe-dismiss-ignore], [role="slider"], input',
				)
			)
				return;
			const touch = event.touches[0],
				node = trackRef.current;
			if (!node || touch.clientY < node.getBoundingClientRect().top) return;
			allowSwipeContextMenu(node);
			const velocity = new GestureVelocity();
			velocity.add(touch.clientX);
			gesture.current = {
				x: touch.clientX,
				y: touch.clientY,
				origin: spring.position,
				distance: 0,
				following: false,
				velocity,
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
			current.velocity.add(event.touches[0].clientX);
			if (!current.following) {
				if (Math.abs(dy) > Math.max(10, Math.abs(dx))) {
					gesture.current = null;
					return;
				}
				if (Math.abs(dx) <= Math.max(10, Math.abs(dy))) return;
				current.origin = spring.position;
				spring.stop();
				current.following = true;
				suppressClick.current = true;
			}
			current.distance = dx;
			const node = trackRef.current;
			suppressSwipeContextMenu(node, true);
			const allowed = dx < 0 ? hasNext : hasPrevious;
			const distance =
				allowed && Math.abs(dx) <= 96
					? dx
					: Math.sign(dx) *
						(allowed
							? 96 + rubberband(Math.abs(dx) - 96, 96)
							: rubberband(Math.abs(dx), 64));
			spring.jump(current.origin + distance, current.velocity.read());
		},
		onTouchEndCapture: (event: TouchEvent) => finish(event, false),
		onTouchCancelCapture: (event: TouchEvent) => finish(event, true),
		onClickCapture: (event: React.MouseEvent) => {
			if (!suppressClick.current) return;
			suppressClick.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
	};
}
