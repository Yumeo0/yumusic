import { type RefObject, useLayoutEffect, useRef } from "react";
import {
	type DismissGeometry,
	measureDismissGeometry,
	type QueueGestureCheck,
} from "@/lib/motion/queue-drag";
import {
	getNowPlayingOpen,
	getQueueOpen,
	getQueueReveal,
	setNowPlayingOpen,
	setQueueOpen,
	setQueueReveal,
} from "@/lib/player/player-ui";

/** Matches Tailwind's max-md breakpoint; swipes mirror the mobile layout. */
const MOBILE_QUERY = "(max-width: 767.98px)";

/** One motion driver for taps, keyboard actions and both swipe directions. */
interface PlayerMotion {
	animate: (open: boolean) => void;
	begin: () => boolean;
	drag: (distance: number, opening: boolean) => void;
	settle: (open: boolean) => void;
}
let motion: PlayerMotion | null = null;

export function useNowPlayingMotion(
	overlayRef: RefObject<HTMLElement | null>,
	open: boolean,
) {
	useLayoutEffect(() => {
		const overlay = overlayRef.current;
		if (!overlay) return;
		let frame = 0;
		let progress = getNowPlayingOpen() ? 0 : 1;
		let geometry: DismissGeometry | null = null;
		let active = false;
		let dragOrigin = progress;
		/** Queue blend the stage rested at when the motion closed the queue. */
		let revealFrom = 0;

		const apply = (value: number) => {
			progress = value;
			overlay.style.setProperty("--np-dismiss", String(value));
			overlay.style.setProperty(
				"--np-slide",
				`${value * (geometry?.height ?? overlay.offsetHeight)}px`,
			);
		};
		const begin = () => {
			cancelAnimationFrame(frame);
			if (!active) {
				// Measure the resting, visible layout, including lyrics mode.
				// Reset/read/restore happens before paint, with easing disabled.
				overlay.dataset.playerMotion = "true";
				// On mobile the queue-up layout (full-bleed cover, controls on
				// the artwork) has no mini-player equivalent: measure the
				// queue-closed layout, then let the motion carry the stage
				// from wherever it rests now back down (see animate) while
				// the sheet itself slides away. Desktop keeps its drawer.
				if (getQueueOpen() && window.matchMedia(MOBILE_QUERY).matches) {
					const reveal = getQueueReveal();
					setQueueOpen(false);
					revealFrom = reveal;
				}
				const previous = progress;
				apply(0);
				geometry = measureDismissGeometry(overlay);
				apply(previous);
				if (revealFrom > 0) setQueueReveal(revealFrom);
				if (!geometry) {
					delete overlay.dataset.playerMotion;
					if (revealFrom > 0) setQueueReveal(0);
					revealFrom = 0;
					return false;
				}
				active = true;
				if (geometry.page) geometry.page.style.overflow = "visible";
				document.documentElement.dataset.playerMorphing = "true";
			}
			overlay.style.visibility = "visible";
			dragOrigin = progress;
			return true;
		};
		const complete = (target: number) => {
			apply(target);
			if (revealFrom > 0) setQueueReveal(0);
			revealFrom = 0;
			active = false;
			overlay.style.visibility = target === 1 ? "hidden" : "visible";
			if (geometry?.page) geometry.page.style.overflow = "";
			// Commit the resting values while nested easing is still off.
			// Re-enabling transitions in the same style pass as the final
			// value change would make every `.np-morph` element (whose
			// transition-all also covers the registered --np-* blends) ease
			// from its pre-change spot — controls flew in from off-screen.
			if (overlay.dataset.playerMotion) void overlay.offsetHeight;
			delete overlay.dataset.playerMotion;
			delete document.documentElement.dataset.playerMorphing;
		};
		const animate = (expanded: boolean) => {
			const target = expanded ? 0 : 1;
			if (progress === target && !active) {
				complete(target);
				return;
			}
			if (!begin()) {
				complete(target);
				return;
			}
			const from = progress;
			const revealStart = revealFrom > 0 ? getQueueReveal() : 0;
			const start = performance.now();
			// Deliberately not gated on prefers-reduced-motion: Windows reports
			// "reduce" whenever its animation effects are off, which made the
			// player snap shut on desktop. The motion is a short spatial
			// transition tied to a deliberate tap, not ambient animation.
			const duration = 300;
			const tick = (now: number) => {
				// rAF timestamps can predate `start`; clamp so the blend
				// never overshoots past either end.
				const time = Math.min(Math.max((now - start) / duration, 0), 1);
				const eased = 1 - (1 - time) ** 3;
				apply(from + (target - from) * eased);
				if (revealStart > 0) setQueueReveal(revealStart * (1 - eased));
				if (time < 1) frame = requestAnimationFrame(tick);
				else complete(target);
			};
			frame = requestAnimationFrame(tick);
		};
		const driver: PlayerMotion = {
			animate,
			begin,
			drag: (distance, opening) => {
				const travel = Math.max(
					geometry?.travel ?? window.innerHeight * 0.6,
					120,
				);
				apply(
					Math.min(
						1,
						Math.max(0, dragOrigin + ((opening ? -1 : 1) * distance) / travel),
					),
				);
			},
			settle: (expanded) => {
				// The store effect runs the same animation for changed targets;
				// explicitly settle when a short/cancelled drag returns to rest.
				if (expanded === getNowPlayingOpen()) animate(expanded);
				else setNowPlayingOpen(expanded);
			},
		};
		motion = driver;
		return () => {
			cancelAnimationFrame(frame);
			complete(getNowPlayingOpen() ? 0 : 1);
			if (motion === driver) motion = null;
		};
	}, [overlayRef]);

	useLayoutEffect(() => {
		motion?.animate(open);
	}, [open]);
}

/** Locks to vertical travel and leaves seeks, lyrics scrolling and taps alone. */
export function useNowPlayingSwipe(
	opening: boolean,
	canStart?: QueueGestureCheck,
) {
	const gesture = useRef<{
		x: number;
		y: number;
		distance: number;
		following: boolean;
	} | null>(null);
	const suppressClick = useRef(false);
	const finish = (cancelled: boolean) => {
		const current = gesture.current;
		gesture.current = null;
		if (!current?.following) return;
		motion?.settle(!cancelled && current.distance >= 64 ? opening : !opening);
	};
	return {
		onClickCapture: (event: React.MouseEvent) => {
			if (!suppressClick.current) return;
			suppressClick.current = false;
			event.preventDefault();
			event.stopPropagation();
		},
		// Capture phase: the song context-menu trigger (long-press menu around
		// the mini player's artwork + title) stops touchstart propagation, so
		// a bubbling listener would never see swipes that begin on it.
		onTouchStartCapture: (event: React.TouchEvent) => {
			suppressClick.current = false;
			gesture.current = null;
			if (
				event.touches.length !== 1 ||
				!window.matchMedia(MOBILE_QUERY).matches ||
				getNowPlayingOpen() === opening ||
				getQueueOpen() ||
				(canStart && !canStart(event)) ||
				(event.target instanceof Element &&
					event.target.closest(
						'[data-swipe-dismiss-ignore], [role="slider"], input',
					))
			)
				return;
			const touch = event.touches[0];
			gesture.current = {
				x: touch.clientX,
				y: touch.clientY,
				distance: 0,
				following: false,
			};
		},
		onTouchMove: (event: React.TouchEvent) => {
			const current = gesture.current;
			if (!current) return;
			if (event.touches.length !== 1) {
				finish(true);
				return;
			}
			const touch = event.touches[0];
			const dy = (touch.clientY - current.y) * (opening ? -1 : 1);
			if (!current.following) {
				if (
					Math.abs(touch.clientX - current.x) > Math.max(10, Math.abs(dy)) ||
					dy < -10
				) {
					gesture.current = null;
					return;
				}
				if (dy < 10) return;
				if (!motion?.begin()) {
					gesture.current = null;
					return;
				}
				current.following = true;
				suppressClick.current = true;
			}
			current.distance = Math.max(0, dy);
			motion?.drag(current.distance, opening);
		},
		onTouchEnd: () => finish(false),
		onTouchCancel: () => finish(true),
	};
}
