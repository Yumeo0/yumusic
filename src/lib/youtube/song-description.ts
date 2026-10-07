import type { Song } from "@/contexts/player-context";
import {
	applySongDescription,
	titleNeedsDescription,
} from "@/lib/utils/description";
import { isVideoId } from "./youtube.utils";
import { getYoutubeClient } from "./youtube-client";

/**
 * Video descriptions, fetched from the player metadata and used to resolve
 * song titles and artists (see `applySongDescription`). Descriptions fetched
 * this session are cached by video id, so a song played after being enriched
 * — or the same song in another playlist — never fetches twice.
 */
const resolved = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

/** Fetches one description from the player response's short description. */
async function fetchDescription(videoId: string): Promise<string | null> {
	try {
		const client = await getYoutubeClient();
		const info = await client.getBasicInfo(videoId);
		return info.basic_info.short_description?.trim() || null;
	} catch (error) {
		console.warn("[descriptions] could not fetch description:", videoId, error);
		return null;
	}
}

/**
 * A video's description, from the session cache when known. Concurrent
 * requests for the same video share one fetch; failures are not cached, so a
 * later visit retries them.
 */
export function fetchSongDescription(videoId: string): Promise<string | null> {
	const known = resolved.get(videoId);
	if (known !== undefined) return Promise.resolve(known);
	const pending = inFlight.get(videoId);
	if (pending) return pending;
	const promise = fetchDescription(videoId)
		.then((description) => {
			if (description) resolved.set(videoId, description);
			return description;
		})
		.finally(() => inFlight.delete(videoId));
	inFlight.set(videoId, promise);
	return promise;
}

/** Records a description seen during playback or a download, skipping refetches. */
export function rememberSongDescription(videoId: string, description: string) {
	if (description) resolved.set(videoId, description);
}

/** Concurrent description fetches; prefetching is background work. */
const CONCURRENCY = 2;
/** Pause between requests per worker, so a long playlist stays polite. */
const REQUEST_GAP_MS = 250;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a description for this video was already fetched this session.
 */
export function hasSongDescription(videoId: string): boolean {
	return resolved.has(videoId);
}

/**
 * Fetches descriptions for the given songs and reports every enriched song
 * through `onUpdate`. Only tracks whose title parsing is ambiguous are
 * fetched (see `titleNeedsDescription`) — a description adds nothing to a
 * title that already parses cleanly. Songs whose description was already
 * fetched this session are enriched from the cache without a request, so
 * their credits reach every list they appear in. `skipIds` excludes tracks
 * that will be enriched by playback anyway (the currently playing song).
 *
 * Runs in the background with a small concurrency limit; returns a function
 * that cancels the remaining fetches (in-flight ones keep running and stay
 * cached).
 */
export function enrichSongsWithDescriptions(
	songs: Song[],
	onUpdate: (song: Song) => void,
	skipIds?: ReadonlySet<string>,
): () => void {
	const queue = songs.filter(
		(song) =>
			isVideoId(song.id) &&
			!song.description &&
			!skipIds?.has(song.id) &&
			(titleNeedsDescription(song) || hasSongDescription(song.id)),
	);
	let cancelled = false;
	const worker = async () => {
		while (!cancelled) {
			const song = queue.shift();
			if (!song) return;
			const description = await fetchSongDescription(song.id);
			if (cancelled || !description) continue;
			const updated = applySongDescription(song, description);
			if (updated !== song) onUpdate(updated);
			await delay(REQUEST_GAP_MS);
		}
	};
	void Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return () => {
		cancelled = true;
	};
}
