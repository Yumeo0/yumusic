import type { MouseEvent, TouchEvent } from "react";
import type { useMiniPlayerTrackSwipe } from "./mini-player-swipe";
import type { useNowPlayingSwipe } from "./now-playing-motion";

/** Both axes must see the whole gesture, even inside a context-menu trigger. */
export function playerSwipeHandlers(
	vertical: ReturnType<typeof useNowPlayingSwipe>,
	horizontal: ReturnType<typeof useMiniPlayerTrackSwipe>,
) {
	return {
		onTouchStartCapture: (event: TouchEvent) => {
			vertical.onTouchStartCapture(event);
			horizontal.onTouchStartCapture(event);
		},
		onTouchMoveCapture: (event: TouchEvent) => {
			horizontal.onTouchMoveCapture(event);
			vertical.onTouchMove(event);
		},
		onTouchEndCapture: (event: TouchEvent) => {
			horizontal.onTouchEndCapture(event);
			vertical.onTouchEnd();
		},
		onTouchCancelCapture: (event: TouchEvent) => {
			horizontal.onTouchCancelCapture(event);
			vertical.onTouchCancel();
		},
		onClickCapture: (event: MouseEvent) => {
			horizontal.onClickCapture(event);
			if (!event.defaultPrevented) vertical.onClickCapture(event);
		},
	};
}
