import { useEffect, useState } from "react";
import { listenRoom } from "../listen-together/room";
import type { PlaybackMedia } from "./playback-deck";
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
	media: PlaybackMedia | null,
	resetKey?: string,
	knownDuration?: number,
) {
	const [currentTime, setCurrentTime] = useState(0);
	const [mediaDuration, setMediaDuration] = useState(0);

	useEffect(() => {
		if (resetKey === undefined) return;
		setCurrentTime(0);
		setMediaDuration(0);
	}, [resetKey]);

	useEffect(() => {
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
		if (!media) return () => window.clearInterval(roomTimer);

		const update = () => {
			if (roomTime()) return;
			setCurrentTime(media.readyState > 0 ? media.currentTime : 0);
			setMediaDuration(
				media.readyState > 0 && Number.isFinite(media.duration)
					? media.duration
					: 0,
			);
		};

		update();

		media.addEventListener("emptied", update);
		media.addEventListener("loadedmetadata", update);
		media.addEventListener("timeupdate", update);
		return () => {
			window.clearInterval(roomTimer);
			media.removeEventListener("emptied", update);
			media.removeEventListener("loadedmetadata", update);
			media.removeEventListener("timeupdate", update);
		};
	}, [media]);

	const duration =
		knownDuration && knownDuration > 0 ? knownDuration : mediaDuration;

	return { currentTime, duration };
}
