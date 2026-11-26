import { useEffect, useState } from "react";
import { listenRoom } from "../listen-together/room";
import { expectedPosition } from "./shared-playback";

/**
 * Tracks currentTime / duration of a media element via timeupdate events.
 * Keeps re-renders local to the calling component (no context churn at 4Hz).
 * `resetKey` (e.g. the song id) zeroes both values immediately when it
 * changes, so the UI shows 00:00 while the next track is still loading.
 * `knownDuration` (seconds from YouTube metadata, when available) takes
 * precedence over the media element's duration so the total matches the
 * length shown in listings.
 */
export function useMediaTime(
	videoElementRef: React.RefObject<HTMLVideoElement | null> | null,
	resetKey?: string,
	knownDuration?: number,
) {
	const [currentTime, setCurrentTime] = useState(0);
	const [mediaDuration, setMediaDuration] = useState(0);

	useEffect(() => {
		// Skip only when no track has played yet (state is already zero)
		if (resetKey === undefined) return;
		setCurrentTime(0);
		setMediaDuration(0);
	}, [resetKey]);

	// Re-attach on `resetKey` too: after a crossfade handover the active
	// element behind `videoElementRef` changes without the ref itself doing
	// so, and the media clock must follow the deck that is now audible.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resetKey is an intentional re-attach trigger, not a read value
	useEffect(() => {
		const videoEl = videoElementRef?.current;
		const roomTime = () => {
			const room = listenRoom.getSnapshot();
			if (
				room.role !== "guest" ||
				room.guestAudio !== "remote" ||
				!room.playback
			)
				return false;
			setCurrentTime(
				expectedPosition(
					room.playback,
					performance.now() + (room.clockOffset ?? 0),
				),
			);
			return true;
		};
		const roomTimer = window.setInterval(roomTime, 250);
		if (!videoEl) return () => window.clearInterval(roomTimer);

		const handleLoadedMetadata = () => {
			if (Number.isFinite(videoEl.duration)) setMediaDuration(videoEl.duration);
		};
		const handleTimeUpdate = () => {
			if (roomTime()) return;
			setCurrentTime(videoEl.currentTime);
			if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
				setMediaDuration(videoEl.duration);
			}
		};

		handleLoadedMetadata();

		videoEl.addEventListener("loadedmetadata", handleLoadedMetadata);
		videoEl.addEventListener("timeupdate", handleTimeUpdate);
		return () => {
			window.clearInterval(roomTimer);
			videoEl.removeEventListener("loadedmetadata", handleLoadedMetadata);
			videoEl.removeEventListener("timeupdate", handleTimeUpdate);
		};
	}, [videoElementRef, resetKey]);

	const duration =
		knownDuration && knownDuration > 0 ? knownDuration : mediaDuration;

	return { currentTime, duration };
}
