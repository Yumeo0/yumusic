import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import {
	NATIVE_AUDIO_EVENT,
	type NativeAudioEvent,
} from "@/lib/player/native-audio";
import { useSettings } from "@/lib/stores/settings";
import { displayTitle, formatArtistName } from "@/lib/utils/title";

interface MediaControlPayload {
	action: string;
	position?: number;
}

/**
 * Bridges playback to the native OS media session (Windows SMTC, macOS Now
 * Playing, Linux MPRIS — see the Rust side). Owning the session natively is
 * what gives the system the app's real name and icon; WebView2's own
 * MediaSession shows up as "Unknown App". The hardware media keys arrive as
 * `media-control` events.
 */
export function MediaSessionSync() {
	const {
		currentSong,
		currentIndex,
		hasNext,
		next,
		previous,
		videoElementRef,
		seek,
	} = usePlayer();
	const { isPlaying, toggle } = usePlayerControls();
	const [settings] = useSettings();

	// Next may roll into the autoplay radio once the queue ends, matching the
	// in-app button; previous stays queue-only so it never rewrites the queue
	// from history.
	const canGoNext = hasNext;
	const canStepPrevious = currentIndex > 0;

	// Media key presses are handled with the latest player state.
	const live = useRef({
		canGoNext,
		canStepPrevious,
		isPlaying,
		next,
		previous,
		toggle,
		videoElementRef,
		seek,
	});
	live.current = {
		canGoNext,
		canStepPrevious,
		isPlaying,
		next,
		previous,
		toggle,
		videoElementRef,
		seek,
	};

	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		const handle = ({ action, position }: MediaControlPayload) => {
			const video = live.current.videoElementRef?.current;
			switch (action) {
				case "play":
					if (!live.current.isPlaying) live.current.toggle();
					break;
				case "pause":
				case "stop":
					if (live.current.isPlaying) live.current.toggle();
					break;
				case "toggle":
					live.current.toggle();
					break;
				case "next":
					if (live.current.canGoNext) void live.current.next();
					break;
				case "previous":
					if (live.current.canStepPrevious) void live.current.previous();
					break;
				case "seek-by":
					if (video && typeof position === "number") {
						live.current.seek(Math.max(0, video.currentTime + position));
					}
					break;
				case "set-position":
					if (video && typeof position === "number") {
						live.current.seek(position);
					}
					break;
			}
		};
		const nativeControl = (event: Event) => {
			const data = (event as CustomEvent<NativeAudioEvent>).detail;
			if (data.type === "control" && data.action)
				handle({ action: data.action, position: data.position });
		};
		window.addEventListener(NATIVE_AUDIO_EVENT, nativeControl);
		listen<MediaControlPayload>("media-control", (event) =>
			handle(event.payload),
		).then((fn) => {
			if (disposed) fn();
			else unlisten = fn;
		});
		return () => {
			disposed = true;
			unlisten?.();
			window.removeEventListener(NATIVE_AUDIO_EVENT, nativeControl);
		};
	}, []);

	const title = currentSong
		? displayTitle(
				currentSong.title,
				// Uploader videos keep their raw title.
				currentSong.upload ? "both" : settings.titleMode,
				settings.cleanTitles,
				currentSong.artist,
			)
		: null;
	const artist = currentSong ? formatArtistName(currentSong.artist) : null;
	const cover = currentSong?.thumbnail ?? null;
	const songId = currentSong?.id ?? null;

	// Snapshot for the native session; the same cover the fullscreen player
	// shows (the OS fetches the URL itself).
	const push = useCallback(() => {
		if (!isTauri()) return;
		const video = videoElementRef?.current;
		const duration =
			video && Number.isFinite(video.duration) && video.duration > 0
				? video.duration
				: null;
		invoke("update_media_session", {
			snapshot: {
				artist,
				canGoNext,
				canGoPrevious: canStepPrevious,
				coverUrl: cover,
				duration,
				id: songId,
				playing: isPlaying,
				position: video?.currentTime ?? 0,
				title,
			},
		}).catch(() => undefined);
	}, [
		artist,
		canGoNext,
		canStepPrevious,
		cover,
		isPlaying,
		songId,
		title,
		videoElementRef,
	]);

	useEffect(() => {
		push();
	}, [push]);

	// Position ticks keep the OS progress bar moving while playing.
	useEffect(() => {
		if (!isPlaying) return;
		const timer = window.setInterval(push, 5000);
		return () => window.clearInterval(timer);
	}, [isPlaying, push]);

	return null;
}
