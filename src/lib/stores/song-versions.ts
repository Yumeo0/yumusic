/**
 * Song-version replacements recorded while playing: when a music video is
 * played, the player resolves YouTube Music's album-track ("song") version of
 * it and records the switched song here, so every list that still holds the
 * video entry renders — and plays — the song version from then on.
 */
import { useSyncExternalStore } from "react";
import type { Song } from "@/contexts/player-context";
import { LruCache } from "@/lib/utils/lru-cache";

const replacements = new LruCache<string, Song>(256);
let snapshot: ReadonlyMap<string, Song> = new Map();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** The recorded song version for a video id, when one was resolved. */
export function songVersionReplacement(id: string): Song | undefined {
	return replacements.get(id);
}

/**
 * Records the song version behind `song`, so list rows showing the video
 * entry render the album track from now on.
 */
export function rememberSongVersion(song: Song, version: Song): void {
	if (song.id === version.id) return;
	replacements.set(song.id, version);
	snapshot = new Map(replacements);
	for (const listener of listeners) listener();
}

/**
 * All recorded replacements, as a reactive map. Components render a row's
 * song as `replacements.get(song.id) ?? song`.
 */
export function useSongVersionReplacements(): ReadonlyMap<string, Song> {
	return useSyncExternalStore(subscribe, () => snapshot);
}
