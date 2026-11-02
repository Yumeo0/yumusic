import { invoke } from "@tauri-apps/api/core";
import { IS_ANDROID, IS_MOBILE } from "./tauri";

export type HapticKind = "tap" | "tick" | "confirm";
let lastFeedback = -Infinity;

/** Feedback only for deliberate interactions; Android respects system preferences. */
export function haptic(kind: HapticKind = "tap") {
	if (typeof window === "undefined") return;
	if (!IS_MOBILE && !window.matchMedia("(pointer: coarse)").matches) return;
	const now = performance.now();
	if (now - lastFeedback < 45) return;
	lastFeedback = now;
	if (IS_ANDROID) {
		void invoke("mobile_haptic", { kind }).catch(() => undefined);
	} else {
		navigator.vibrate?.(kind === "confirm" ? 20 : 8);
	}
}

const CONTROLS =
	'button, a[href], select, input[type="range"], input[type="checkbox"], input[type="radio"], [role="button"], [role="switch"], [role="slider"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="option"]';

export function installMobileHaptics() {
	const feedback = (event: Event) => {
		if (!event.isTrusted) return;
		const target =
			event.target instanceof Element ? event.target.closest(CONTROLS) : null;
		if (
			!target ||
			target.matches(':disabled, [aria-disabled="true"]') ||
			target.closest(
				'[inert], [data-haptic="none"], [aria-haspopup]:not([aria-haspopup="false"]), .context-menu-highlight[data-popup-open]',
			)
		)
			return;
		if (event.type === "pointerup" && !target.matches('[role="slider"]'))
			return;
		// Observe capture-phase events even when a control stops propagation.
		// Defer until swipe handlers can cancel their synthetic click.
		queueMicrotask(() => {
			if (!event.defaultPrevented)
				haptic(event.type === "input" ? "tick" : "tap");
		});
	};
	document.addEventListener("click", feedback, true);
	document.addEventListener("pointerup", feedback, true);
	document.addEventListener("change", feedback);
	document.addEventListener("input", feedback);
	return () => {
		document.removeEventListener("click", feedback, true);
		document.removeEventListener("pointerup", feedback, true);
		document.removeEventListener("change", feedback);
		document.removeEventListener("input", feedback);
	};
}
