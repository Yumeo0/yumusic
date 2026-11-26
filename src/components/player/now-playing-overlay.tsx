import { useEffect, useRef } from "react";
import {
	useNowPlayingMotion,
	useNowPlayingSwipe,
} from "@/lib/motion/now-playing-motion";
import {
	setQueueOpen,
	toggleNowPlaying,
	toggleQueue,
	useNowPlayingOpen,
	useQueueOpen,
} from "@/lib/player/player-ui";
import { NowPlayingPage } from "@/pages/now-playing";

export function NowPlayingOverlay() {
	const isNowPlayingOpen = useNowPlayingOpen();
	const isQueueOpen = useQueueOpen();
	const overlayRef = useRef<HTMLElement>(null);
	useNowPlayingMotion(overlayRef, isNowPlayingOpen);
	// Dragging down on the fullscreen player minimizes it — but only while the
	// queue is closed: with the sheet open, the same swipe drags the queue.
	// The scrollable lyrics column opts out so it keeps scrolling normally.
	const dismissGesture = useNowPlayingSwipe(false);

	// Escape closes the queue first, then the fullscreen view
	useEffect(() => {
		if (!isNowPlayingOpen) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			e.preventDefault();
			if (isQueueOpen) {
				setQueueOpen(false);
			} else {
				toggleNowPlaying();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [isNowPlayingOpen, isQueueOpen]);

	return (
		<section
			aria-hidden={!isNowPlayingOpen}
			aria-label="Now Playing"
			className="np-overlay invisible fixed inset-0 z-50"
			inert={!isNowPlayingOpen}
			ref={overlayRef}
			style={{ transform: "translateY(var(--np-slide, 0px))" }}
			{...dismissGesture}
		>
			<NowPlayingPage
				isQueueOpen={isQueueOpen}
				onClose={toggleNowPlaying}
				onToggleQueue={toggleQueue}
			/>
		</section>
	);
}
