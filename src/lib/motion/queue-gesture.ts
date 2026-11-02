import { useEffect, useRef } from "react";
import { useQueueSheetRef } from "@/contexts/player-context";
import {
	getQueueState,
	type QueueState,
	setQueueReveal,
	setQueueState,
} from "@/lib/player/player-ui";
import { haptic } from "@/lib/utils/haptics";
import { QUEUE_STAGES, queueDragStage, queueStageOffset } from "./queue-stages";

// Opening from the player and dragging the header share a single sheet.
let cancelActiveSpring: (() => void) | null = null;

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

function useQueueGesture(opening: boolean, canStart?: QueueGestureCheck) {
	const sheetRef = useQueueSheetRef();
	const gesture = useRef<{
		x: number;
		y: number;
		rest: QueueState;
		stage: QueueState;
		dragging: boolean;
	} | null>(null);
	const suppressClick = useRef(false);
	const spring = useRef({
		position: 0,
		velocity: 0,
		target: 0,
		frame: 0,
		time: 0,
		settling: false,
		ownerState: getQueueState(),
	});
	const reset = () => {
		cancelAnimationFrame(spring.current.frame);
		spring.current.frame = 0;
		const sheet = sheetRef?.current;
		if (sheet) {
			sheet.style.translate = "";
			sheet.style.transition = "";
		}
		delete document.documentElement.dataset.morphDragging;
	};
	useEffect(
		() => () => {
			cancelAnimationFrame(spring.current.frame);
			delete document.documentElement.dataset.morphDragging;
		},
		[],
	);
	const render = () => {
		const sheet = sheetRef?.current;
		if (!sheet) return;
		sheet.style.translate = `0 ${spring.current.position}px`;
		setQueueReveal(
			(1 -
				spring.current.position / (sheet.offsetHeight || window.innerHeight)) *
				2,
		);
	};
	const move = (target: number, settling = false, magnet = false) => {
		const state = spring.current;
		state.target = target;
		state.settling = settling;
		state.ownerState = getQueueState();
		// Follow the finger directly between the short spring capture zones.
		if (!settling && !magnet) {
			cancelAnimationFrame(state.frame);
			state.frame = 0;
			state.position = target;
			state.velocity = 0;
			render();
			return;
		}
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			state.position = target;
			render();
			if (settling) reset();
			return;
		}
		if (state.frame) return;
		state.time = performance.now();
		const tick = (now: number) => {
			if (getQueueState() !== state.ownerState) {
				reset();
				setQueueReveal(getQueueState() === "closed" ? 0 : 1);
				return;
			}
			const elapsed = Math.min(
				0.032,
				Math.max(0.001, (now - state.time) / 1000),
			);
			state.time = now;
			const steps = Math.ceil(elapsed / 0.008),
				dt = elapsed / steps;
			for (let i = 0; i < steps; i++) {
				state.velocity +=
					((state.target - state.position) * 520 - state.velocity * 30) * dt;
				state.position += state.velocity * dt;
			}
			const done =
				Math.abs(state.target - state.position) < 0.25 &&
				Math.abs(state.velocity) < 2;
			if (done) {
				state.position = state.target;
				state.velocity = 0;
			}
			render();
			state.frame = done ? 0 : requestAnimationFrame(tick);
			if (done && state.settling) reset();
		};
		state.frame = requestAnimationFrame(tick);
	};
	const finish = (cancelled: boolean) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current?.dragging) return;
		const stage = cancelled ? current.rest : current.stage;
		setQueueState(stage);
		move(
			(QUEUE_STAGES.indexOf(stage) *
				(sheetRef?.current?.offsetHeight || window.innerHeight)) /
				2,
			true,
		);
	};
	return {
		onClickCapture: (event: React.MouseEvent) => {
			if (suppressClick.current) {
				event.preventDefault();
				event.stopPropagation();
			}
		},
		onTouchStart: (event: React.TouchEvent) => {
			suppressClick.current = false;
			gesture.current = null;
			if (
				event.touches.length !== 1 ||
				!window.matchMedia("(max-width: 767.98px)").matches ||
				(getQueueState() === "closed") !== opening ||
				(canStart && !canStart(event))
			)
				return;
			const touch = event.touches[0];
			gesture.current = {
				x: touch.clientX,
				y: touch.clientY,
				rest: getQueueState(),
				stage: getQueueState(),
				dragging: false,
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
			if (!current.dragging) {
				if (
					Math.abs(touch.clientX - current.x) > Math.max(10, Math.abs(distance))
				) {
					gesture.current = null;
					return;
				}
				if (Math.abs(distance) < 10 || (opening && distance < 0)) return;
				cancelActiveSpring?.();
				reset();
				cancelActiveSpring = reset;
				const height = sheetRef?.current?.offsetHeight || window.innerHeight;
				spring.current.position =
					(QUEUE_STAGES.indexOf(current.rest) * height) / 2;
				spring.current.velocity = 0;
				current.dragging = true;
				suppressClick.current = true;
				document.documentElement.dataset.morphDragging = "true";
				if (opening) setQueueState("half");
				if (sheetRef?.current) sheetRef.current.style.transition = "none";
				render();
			}
			if (event.cancelable) event.preventDefault();
			const height = sheetRef?.current?.offsetHeight || window.innerHeight;
			const stage = queueDragStage(current.rest, distance);
			if (stage !== current.stage) haptic("tick");
			current.stage = stage;
			const offset = queueStageOffset(current.rest, stage, distance, height);
			const finger = Math.max(
				0,
				Math.min(
					height,
					(QUEUE_STAGES.indexOf(current.rest) * height) / 2 - distance,
				),
			);
			move(offset, false, Math.abs(offset - finger) > 0.5);
		},
		onTouchEnd: () => finish(false),
		onTouchCancel: () => finish(true),
	};
}
export const useQueueDragGesture = (canStart?: QueueGestureCheck) =>
	useQueueGesture(true, canStart);
export const useQueueSheetGesture = (canStart?: QueueGestureCheck) =>
	useQueueGesture(false, canStart);
