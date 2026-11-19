import { type RefObject, useLayoutEffect, useRef } from "react";
import {
	getQueueState,
	type QueueState,
	setQueueReveal,
	setQueueState,
} from "@/lib/player/player-ui";
import { haptic } from "@/lib/utils/haptics";
import { QUEUE_STAGES, queueReleaseStage } from "./queue-stages";
import { createSpring, GestureVelocity, rubberband } from "./spring";

const MOBILE_QUERY = "(max-width: 767.98px)";
export type QueueGestureCheck = (event: React.TouchEvent) => boolean;
export interface TouchHandlers {
	onTouchStart: (event: React.TouchEvent) => void;
	onTouchMove: (event: React.TouchEvent) => void;
	onTouchEnd: (event: React.TouchEvent) => void;
	onTouchCancel: (event: React.TouchEvent) => void;
}
export function mergeTouchHandlers(...sets: TouchHandlers[]): TouchHandlers {
	const run = (key: keyof TouchHandlers, event: React.TouchEvent) => {
		for (const handlers of sets) handlers[key](event);
	};
	return {
		onTouchStart: (e) => run("onTouchStart", e),
		onTouchMove: (e) => run("onTouchMove", e),
		onTouchEnd: (e) => run("onTouchEnd", e),
		onTouchCancel: (e) => run("onTouchCancel", e),
	};
}

interface QueueMotion {
	begin: () => number;
	drag: (position: number, velocity: number) => void;
	settle: (stage: QueueState, velocity?: number) => void;
	height: () => number;
	update: (stage: QueueState) => void;
	moving: () => boolean;
}
let motion: QueueMotion | null = null;

/** Taps and gestures share one presentation value, including mid-flight grabs. */
export function useQueueMotion(
	sheetRef: RefObject<HTMLElement | null> | null | undefined,
	stage: QueueState,
) {
	useLayoutEffect(() => {
		const sheet = sheetRef?.current;
		if (!sheet) return;
		const mobile = () => window.matchMedia(MOBILE_QUERY).matches;
		const height = () => sheet.offsetHeight || window.innerHeight;
		const offset = (state: QueueState) =>
			mobile()
				? (QUEUE_STAGES.indexOf(state) * height()) / 2
				: state === "closed"
					? sheet.offsetWidth
					: 0;
		let dragging = false;
		let moving = false;
		let targetState = getQueueState();
		const apply = (position: number) => {
			sheet.style.translate = mobile() ? `0 ${position}px` : `${position}px 0`;
			setQueueReveal(
				mobile()
					? (1 - position / height()) * 2
					: getQueueState() === "closed"
						? 0
						: 1,
			);
		};
		const spring = createSpring(offset(getQueueState()), apply);
		const rest = () => {
			moving = false;
			sheet.inert = getQueueState() === "closed";
			delete document.documentElement.dataset.morphDragging;
		};
		const driver = {
			height,
			moving: () => moving,
			begin: () => {
				spring.stop();
				dragging = true;
				document.documentElement.dataset.morphDragging = "true";
				return spring.position;
			},
			drag: (position: number, velocity: number) =>
				spring.jump(position, velocity),
			settle: (state: QueueState, velocity?: number) => {
				dragging = false;
				moving = true;
				sheet.inert = false;
				targetState = state;
				document.documentElement.dataset.morphDragging = "true";
				spring.animate(offset(state), {
					velocity,
					momentum: velocity !== undefined,
					onRest: rest,
				});
			},
			update: (state: QueueState) => {
				if (!dragging && state !== targetState) driver.settle(state);
			},
		};
		motion = driver;
		apply(spring.position);
		const resize = new ResizeObserver(() => {
			if (dragging) return;
			spring.jump(offset(getQueueState()));
			rest();
		});
		resize.observe(sheet);
		return () => {
			resize.disconnect();
			spring.stop();
			rest();
			if (motion === driver) motion = null;
		};
	}, [sheetRef]);
	useLayoutEffect(() => {
		// The gesture owns the presentation value until release.
		motion?.update(stage);
	}, [stage]);
}

function useQueueGesture(opening: boolean, canStart?: QueueGestureCheck) {
	const gesture = useRef<{
		x: number;
		y: number;
		rest: QueueState;
		stage: QueueState;
		origin: number;
		distance: number;
		dragging: boolean;
		velocity: GestureVelocity;
	} | null>(null);
	const suppressClick = useRef(false);
	const finish = (cancelled: boolean) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current?.dragging) return;
		const velocity = cancelled ? 0 : current.velocity.read();
		const stage = cancelled
			? current.rest
			: queueReleaseStage(
					current.origin - current.distance,
					motion?.height() ?? window.innerHeight,
					velocity,
					current.origin,
				);
		setQueueState(stage);
		motion?.settle(stage, velocity);
	};
	return {
		onClickCapture: (event: React.MouseEvent) => {
			if (!suppressClick.current) return;
			suppressClick.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
		onTouchStart: (event: React.TouchEvent) => {
			suppressClick.current = false;
			gesture.current = null;
			if (
				event.touches.length !== 1 ||
				!window.matchMedia(MOBILE_QUERY).matches ||
				((getQueueState() === "closed") !== opening && !motion?.moving()) ||
				(canStart && !canStart(event))
			)
				return;
			const touch = event.touches[0];
			const velocity = new GestureVelocity();
			velocity.add(touch.clientY);
			gesture.current = {
				x: touch.clientX,
				y: touch.clientY,
				rest: getQueueState(),
				stage: getQueueState(),
				origin: 0,
				distance: 0,
				dragging: false,
				velocity,
			};
		},
		onTouchMove: (event: React.TouchEvent) => {
			const current = gesture.current,
				touch = event.touches[0];
			if (!current || !touch) return;
			if (event.touches.length !== 1) {
				finish(true);
				return;
			}
			const distance = current.y - touch.clientY;
			current.velocity.add(touch.clientY);
			if (!current.dragging) {
				if (
					Math.abs(touch.clientX - current.x) > Math.max(10, Math.abs(distance))
				) {
					gesture.current = null;
					return;
				}
				if (Math.abs(distance) < 10 || (opening && distance < 0) || !motion)
					return;
				current.origin = motion.begin();
				current.dragging = true;
				suppressClick.current = true;
				if (opening) setQueueState("half");
			}
			if (event.cancelable) event.preventDefault();
			current.distance = distance;
			const height = motion?.height() ?? window.innerHeight;
			const stage = queueReleaseStage(current.origin - distance, height);
			if (stage !== current.stage) haptic("tick");
			current.stage = stage;
			const finger = current.origin - distance;
			const position =
				finger < 0
					? rubberband(finger, height)
					: finger > height
						? height + rubberband(finger - height, height)
						: finger;
			motion?.drag(position, current.velocity.read());
		},
		onTouchEnd: () => finish(false),
		onTouchCancel: () => finish(true),
	};
}
export const useQueueDragGesture = (canStart?: QueueGestureCheck) =>
	useQueueGesture(true, canStart);
export const useQueueSheetGesture = (canStart?: QueueGestureCheck) =>
	useQueueGesture(false, canStart);
