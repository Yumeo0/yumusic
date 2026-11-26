import type { Song } from "@/lib/music/song";
import type { SongEnrichment } from "@/lib/music/song-enrichment";
import { titleNeedsDescription } from "@/lib/utils/description";
import { LruCache } from "@/lib/utils/lru-cache";
import { formatTitleParts, splitDualTitle } from "@/lib/utils/title";
import { getYoutubeClient } from "./client-session";
import { getTrackQueueMeta } from "./track-meta";
import { isVideoId } from "./youtube.utils";

/**
 * Background song enrichment for list rows. Video descriptions resolve song
 * titles and artists (see `applySongDescription`), and uploader-video
 * detection keeps a reupload's raw title out of the dual-title parser.
 * Descriptions fetched this session are cached by video id, so a song played
 * after being enriched — or the same song in another playlist — never fetches
 * twice.
 */
const resolved = new LruCache<string, string>(256);
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

/**
 * Whether a list row could still be an uploader video: its title reads as an
 * original/translation pair (the raw title and the parsed display differ),
 * and no verdict has been recorded yet. Only those rows are worth checking —
 * the flag changes nothing for any other title.
 */
export function needsUploadCheck(song: Song): boolean {
	if (song.upload !== undefined || !song.title) return false;
	if (splitDualTitle(song.title)) return true;
	return (
		splitDualTitle(formatTitleParts(song.title, "both", true).main) !== null
	);
}

const CONCURRENCY = 2;
const REQUEST_GAP_MS = 250;

type DeliverEnrichment = (videoId: string, enrichment: SongEnrichment) => void;

function createEnrichmentQueue(
	load: (videoId: string) => Promise<SongEnrichment | null>,
	deliver: DeliverEnrichment,
) {
	const queued = new Set<string>();
	const active = new Set<string>();
	let workers = 0;
	let cancelled = false;

	async function work() {
		workers++;
		try {
			while (!cancelled) {
				const videoId = queued.values().next().value;
				if (!videoId) return;
				queued.delete(videoId);
				active.add(videoId);
				try {
					const enrichment = await load(videoId);
					if (!cancelled && enrichment) deliver(videoId, enrichment);
				} catch (error) {
					console.warn("[descriptions] could not enrich song:", videoId, error);
				} finally {
					active.delete(videoId);
				}
				// Pace every provider attempt, including empty or failed responses.
				if (!cancelled)
					await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP_MS));
			}
		} finally {
			workers--;
		}
	}

	return {
		add(videoId: string) {
			if (cancelled || active.has(videoId)) return;
			queued.add(videoId);
			while (queued.size > 0 && workers < CONCURRENCY) void work();
		},
		cancel() {
			cancelled = true;
			queued.clear();
		},
	};
}

/** Each provider keeps its own request budget across progressive page loads. */
export function createSongRowEnrichment(deliver: DeliverEnrichment) {
	const descriptions = createEnrichmentQueue(async (videoId) => {
		const description = await fetchSongDescription(videoId);
		return description ? { description } : null;
	}, deliver);
	const uploads = createEnrichmentQueue(async (videoId) => {
		const meta = await getTrackQueueMeta(videoId);
		return meta && !meta.album ? { upload: true } : null;
	}, deliver);

	return {
		add(songs: Song[], playingId?: string) {
			for (const song of songs) {
				if (!isVideoId(song.id)) continue;
				// Playback supplies its own description for the current song.
				if (
					song.id !== playingId &&
					!song.description &&
					(titleNeedsDescription(song) || resolved.has(song.id))
				) {
					descriptions.add(song.id);
				}
				if (needsUploadCheck(song)) uploads.add(song.id);
			}
		},
		cancel() {
			descriptions.cancel();
			uploads.cancel();
		},
	};
}

export function enrichSongRows(
	songs: Song[],
	deliver: DeliverEnrichment,
	playingId?: string,
) {
	const enrichment = createSongRowEnrichment(deliver);
	enrichment.add(songs, playingId);
	return enrichment.cancel;
}
