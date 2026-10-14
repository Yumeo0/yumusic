/**
 * Song-version replacements recorded while playing: when a music video is
 * played, the player resolves YouTube Music's album-track ("song") version of
 * it and records the switched song here, so every list that still holds the
 * video entry renders — and plays — the song version from then on.
 */
import { createStore } from "solid-js";
import type { Song } from "@/contexts/player-context";

const [replacements, setReplacements] = createStore<Record<string, Song>>({});

/** The recorded song version for a video id, when one was resolved. */
export function songVersionReplacement(id: string): Song | undefined {
	return replacements[id];
}

/**
 * Records the song version behind `song`, so list rows showing the video
 * entry render the album track from now on.
 */
export function rememberSongVersion(song: Song, version: Song): void {
	if (song.id === version.id) return;
	setReplacements((state) => {
		state[song.id] = version;
	});
}

/**
 * All recorded replacements. Components render a row's song as
 * `replacements.get(song.id) ?? song`; the read tracks where it renders.
 */
export function useSongVersionReplacements() {
	return {
		get: (id: string) => replacements[id],
	};
}
