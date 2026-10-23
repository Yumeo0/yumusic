import { useEffect, useSyncExternalStore } from "react";
import { LruCache } from "@/lib/utils/lru-cache";
import { isVideoId } from "@/lib/youtube/youtube.utils";
import {
	getSongRating,
	type SongRating,
	setSongRating,
} from "@/lib/youtube/youtube-client";
import { showToast } from "./toast";

export interface SongRatingState {
	/** The account's rating for the song. */
	rating: SongRating;
	/** True while an update is being sent to YouTube. */
	busy: boolean;
	/** True once this session has tried to read the rating from YouTube. */
	loaded: boolean;
}

const UNKNOWN: SongRatingState = Object.freeze({
	rating: null,
	busy: false,
	loaded: false,
});

/**
 * Ratings are persisted so playlist rows show their real state immediately
 * even when the playlist itself comes from the localStorage cache — otherwise
 * every row would wait for a hover-triggered lookup.
 */
const STORAGE_KEY = "yumusic:song-ratings:v1";
/** Older ratings are re-read; matches the playlist cache's sync window. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Bounds the persisted map so it cannot grow without limit. */
const MAX_ENTRIES = 5000;

interface PersistedRating {
	rating: SongRating;
	at: number;
}

const states = new LruCache<string, SongRatingState>(MAX_ENTRIES);
/** When each state was last confirmed, for the persistence TTL. */
const updatedAt = new LruCache<string, number>(MAX_ENTRIES);
const listeners = new Set<() => void>();
/** In-flight rating reads, so concurrent hovers share one request. */
const reads = new Map<string, Promise<void>>();
/** Songs the user rated this session: a late read/seed must not undo it. */
const touched = new LruCache<string, true>(MAX_ENTRIES);

function restore() {
	if (typeof localStorage === "undefined") return;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return;
		const parsed = JSON.parse(raw) as Record<string, PersistedRating>;
		const now = Date.now();
		for (const [songId, entry] of Object.entries(parsed)) {
			if (!isVideoId(songId) || !entry) continue;
			if (
				entry.rating !== "like" &&
				entry.rating !== "dislike" &&
				entry.rating !== null
			) {
				continue;
			}
			if (!Number.isFinite(entry.at) || now - entry.at > MAX_AGE_MS) continue;
			states.set(songId, { rating: entry.rating, busy: false, loaded: true });
			updatedAt.set(songId, entry.at);
		}
	} catch (error) {
		console.warn("[YuMusic] failed to restore song ratings:", error);
	}
}

function persist() {
	if (typeof localStorage === "undefined") return;
	try {
		const now = Date.now();
		const entries = [...states.entries()]
			.filter(([songId, state]) => {
				const at = updatedAt.get(songId);
				return (
					state.loaded &&
					!state.busy &&
					at !== undefined &&
					now - at <= MAX_AGE_MS &&
					isVideoId(songId)
				);
			})
			.map(([songId, state]): [string, PersistedRating] => [
				songId,
				{ rating: state.rating, at: updatedAt.get(songId) ?? now },
			])
			.sort((a, b) => a[1].at - b[1].at)
			.slice(-MAX_ENTRIES);
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(Object.fromEntries(entries)),
		);
	} catch (error) {
		console.warn("[YuMusic] failed to persist song ratings:", error);
	}
}

restore();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function setState(songId: string, state: SongRatingState) {
	states.set(songId, state);
	emit();
}

function stateOf(songId: string | null | undefined): SongRatingState {
	return (songId && states.get(songId)) || UNKNOWN;
}

/**
 * Seeds ratings carried by a list response — playlist, album and artist
 * shelves include the account's like/dislike state for every row. Seeding
 * makes those rows show the real state immediately instead of waiting for a
 * per-song lookup; a rating the user changed this session always wins.
 */
export function seedSongRatings(
	entries: Iterable<{ id: string; rating: SongRating }>,
): void {
	const now = Date.now();
	let changed = false;
	let refreshed = false;
	for (const { id, rating } of entries) {
		if (!id || !isVideoId(id) || touched.has(id)) continue;
		const current = states.get(id);
		if (current?.busy) continue;
		// The snapshot is fresh even when the rating itself did not change;
		// refreshing the timestamp keeps it from expiring prematurely.
		updatedAt.set(id, now);
		refreshed = true;
		if (current?.loaded && current.rating === rating) continue;
		states.set(id, { rating, busy: false, loaded: true });
		changed = true;
	}
	if (changed || refreshed) persist();
	if (changed) emit();
}

/**
 * Reads the account's rating for a song once per session. Safe to call from
 * hover handlers: repeated and concurrent calls share one request, and a
 * failed lookup is not retried automatically.
 */
export function loadSongRating(songId: string | null | undefined): void {
	if (!songId || !isVideoId(songId)) return;
	if (stateOf(songId).loaded || reads.has(songId)) return;
	const request = getSongRating(songId)
		.then((rating) => {
			if (rating === undefined) {
				// Could not determine it (signed out/offline): stop retrying,
				// but do not persist the guess.
				setState(songId, { ...stateOf(songId), loaded: true });
				return;
			}
			// The user rated the song while the lookup was in flight.
			if (touched.has(songId)) {
				setState(songId, { ...stateOf(songId), loaded: true });
				return;
			}
			updatedAt.set(songId, Date.now());
			setState(songId, { rating, busy: stateOf(songId).busy, loaded: true });
			persist();
		})
		.catch((error) => {
			console.warn("[YuMusic] failed to load song rating:", error);
			setState(songId, { ...stateOf(songId), loaded: true });
		})
		.finally(() => {
			reads.delete(songId);
		});
	reads.set(songId, request);
}

/**
 * Applies a rating to a song on the YouTube account. Pressing the active
 * rating again clears it, matching YouTube Music's toggle.
 */
export function rateSong(songId: string, next: "like" | "dislike"): void {
	if (!isVideoId(songId)) {
		showToast("This song cannot be rated");
		return;
	}
	const state = stateOf(songId);
	if (state.busy) return;
	const previous = state.rating;
	const target: SongRating = previous === next ? null : next;
	touched.set(songId, true);
	setState(songId, { rating: target, busy: true, loaded: state.loaded });
	void setSongRating(songId, target)
		.then(() => {
			updatedAt.set(songId, Date.now());
			setState(songId, {
				rating: target,
				busy: false,
				loaded: true,
			});
			persist();
		})
		.catch((error) => {
			console.error("[YuMusic] rating update failed:", error);
			setState(songId, {
				rating: previous,
				busy: false,
				loaded: stateOf(songId).loaded,
			});
			showToast(
				error instanceof Error && /signed in/i.test(error.message)
					? "Sign in to rate songs"
					: "Could not update the rating",
			);
		});
}

/**
 * Reactive rating for one song. `eager` reads the state on mount (the player);
 * list rows pass false and call `loadSongRating` when the row is hovered, so
 * a long playlist does not fire a request per row.
 */
export function useSongRating(
	songId: string | null | undefined,
	{ eager = true }: { eager?: boolean } = {},
) {
	const state = useSyncExternalStore(
		subscribe,
		() => stateOf(songId),
		() => UNKNOWN,
	);

	useEffect(() => {
		if (eager) loadSongRating(songId);
	}, [songId, eager]);

	return {
		rating: state.rating,
		busy: state.busy,
		/** False until YouTube confirmed (or failed to report) the rating. */
		loaded: state.loaded,
		rate: (next: "like" | "dislike") => {
			if (songId) rateSong(songId, next);
		},
	};
}
