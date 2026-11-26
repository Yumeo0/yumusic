import type { Song } from "@/lib/music/song";
import { nextQueueIndex, type RepeatMode } from "./repeat";

export interface UpcomingTracks {
	queue: Song[];
	currentSong: Song | null;
	currentIndex: number;
	repeatMode: RepeatMode;
	autoplayTracks: Song[];
	autoplayEnabled: boolean;
}

export type TransitionTrack = {
	kind: "queue" | "autoplay";
	song: Song;
	index: number;
};

export function nextTrack(
	{
		queue,
		currentSong,
		currentIndex,
		repeatMode,
		autoplayTracks,
		autoplayEnabled,
	}: UpcomingTracks,
	trigger: "skip" | "ended",
	finishQueue: boolean,
): TransitionTrack | { kind: "repeat" | "radio"; song: Song } | null {
	const index = nextQueueIndex(
		currentIndex,
		queue.length,
		finishQueue ? "off" : repeatMode,
		trigger === "ended",
	);
	if (
		trigger === "ended" &&
		!finishQueue &&
		currentSong &&
		(repeatMode === "one" || index === currentIndex)
	) {
		return { kind: "repeat", song: currentSong };
	}
	if (index !== null && queue[index]) {
		return { kind: "queue", song: queue[index], index };
	}
	if (finishQueue || !autoplayEnabled || !currentSong) return null;
	const song = autoplayTracks[0];
	return song
		? { kind: "autoplay", song, index: queue.length }
		: { kind: "radio", song: currentSong };
}
