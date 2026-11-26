import type { YTNodes } from "youtubei.js/web";
import { LruCache } from "../utils/lru-cache";
import { biggestThumb, hiResThumb } from "../utils/utils";
import { getYoutubeClient } from "./client-session";
import { getOembedMetadata } from "./oembed";
import { queueArtists, queueEntries } from "./queue-panel";
import { type SongVersion, songVersionEntryFromQueue } from "./song-version";
import { youtubeFetch } from "./youtube-fetch";

/**
 * The album-track version of the video, when YouTube Music pairs one. Read
 * from the Up Next queue that the track metadata already fetches, so it
 * shares the per-track cache; resolves to null when the video has no version
 * (or the queue is unavailable).
 */
export async function getSongVersion(
	videoId: string,
): Promise<SongVersion | null> {
	const meta = await getTrackMeta(videoId);
	return meta?.songVersion ?? null;
}

export interface TrackMeta {
	album?: { name: string; id?: string };
	artists: { name: string; id?: string }[];
	/** Uploader's original title, from the public oEmbed endpoint. */
	originalTitle?: string;
	/** Primary artist credit, in the session's fetch language. */
	originalArtist?: string;
	/** Audio-track ("song") version of a music video, when the queue has one. */
	songVersion?: SongVersion;
}

/**
 * Session cache for queue metadata: it is locale-stable and costs a queue
 * fetch, so a track played, scrobbled and enriched only fetches it once.
 */
const trackMetaCache = new LruCache<string, TrackMeta>(256);
const trackMetaRequests = new Map<string, Promise<TrackMeta | null>>();

/**
 * Album and artist metadata for a track, taken from the selected entry of the
 * "Up next" queue (fetched in the app's current language). The original title
 * comes from oEmbed, which is locale-independent; failures resolve to null so
 * callers keep working without it.
 */
export function getTrackMeta(videoId: string): Promise<TrackMeta | null> {
	const known = trackMetaCache.get(videoId);
	if (known) return Promise.resolve(known);
	const pending = trackMetaRequests.get(videoId);
	if (pending) return pending;
	const request = fetchTrackMeta(videoId)
		.then((meta) => {
			if (meta) trackMetaCache.set(videoId, meta);
			return meta;
		})
		.finally(() => trackMetaRequests.delete(videoId));
	trackMetaRequests.set(videoId, request);
	return request;
}

/** The song-version metadata the queue's counterpart entry carries. */
function toSongVersion(entry: YTNodes.PlaylistPanelVideo): SongVersion {
	const artists = queueArtists(entry);
	return {
		id: entry.video_id,
		title: entry.title?.toString() || undefined,
		artists: artists.length > 0 ? artists : undefined,
		duration: entry.duration?.text || undefined,
		thumbnail: hiResThumb(biggestThumb(entry.thumbnail)?.url) || undefined,
		album: entry.album
			? { name: entry.album.name, id: entry.album.id }
			: undefined,
	};
}

async function fetchTrackMeta(videoId: string): Promise<TrackMeta | null> {
	try {
		const client = await getYoutubeClient();
		// Queue metadata needs no player response or playable stream. Fetch it
		// directly so artist links still resolve when playback info is blocked.
		const queue = await client.music.getUpNext(videoId, false);
		const videos: YTNodes.PlaylistPanelVideo[] = [];
		const wrappers: YTNodes.PlaylistPanelVideoWrapper[] = [];
		for (const { video, wrapper } of queueEntries(queue)) {
			videos.push(video);
			if (wrapper) wrappers.push(wrapper);
		}
		const current =
			videos.find((video) => video.video_id === videoId) ??
			videos.find((video) => video.selected);
		if (!current) return null;
		const versionEntry = songVersionEntryFromQueue(wrappers, videoId);
		const oembed = await getOembedMetadata(videoId, (input, init) =>
			youtubeFetch(input, init),
		);
		return {
			album: current.album
				? { name: current.album.name, id: current.album.id }
				: undefined,
			artists: queueArtists(current),
			originalTitle: oembed?.title ?? undefined,
			originalArtist: current.artists?.[0]?.name || undefined,
			songVersion: versionEntry ? toSongVersion(versionEntry) : undefined,
		};
	} catch (error) {
		console.warn("[YuMusic] failed to load track metadata:", error);
		return null;
	}
}
