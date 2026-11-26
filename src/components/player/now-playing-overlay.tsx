import { lazy, memo, Suspense, useEffect, useRef, useState } from "react";
import { usePlayer } from "@/contexts/player-context";
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

const NowPlayingPage = lazy(() =>
	import("@/pages/now-playing").then(({ NowPlayingPage }) => ({
		default: NowPlayingPage,
	})),
);

export function NowPlayingOverlay() {
	const { currentSong } = usePlayer();
	const isNowPlayingOpen = useNowPlayingOpen();
	const hasPlayer = currentSong !== null || isNowPlayingOpen;
	const [requested, setRequested] = useState(hasPlayer);
	// Load on first track selection so the gesture can measure the player
	// before it opens. Retain the surface for later tracks and close animations.
	if (hasPlayer && !requested) setRequested(true);
	if (!requested) return null;
	return (
		<Suspense fallback={null}>
			<NowPlayingSurface isNowPlayingOpen={isNowPlayingOpen} />
		</Suspense>
	);
}

const NowPlayingSurface = memo(function NowPlayingSurface({
	isNowPlayingOpen,
}: {
	isNowPlayingOpen: boolean;
}) {
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
});
