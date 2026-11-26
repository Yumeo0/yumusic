import { type Innertube, YTNodes } from "youtubei.js/web";
import type { Song } from "../music/song";
import { biggestThumb, hiResThumb } from "../utils/utils";
import { getYoutubeClient } from "./client-session";
import { queueArtists, queueEntries } from "./queue-panel";

type Artist = Awaited<ReturnType<Innertube["music"]["getArtist"]>>;

/** Converts a queue panel's videos into playable tracks, skipping `skipId`. */
function panelTracks(panel: YTNodes.PlaylistPanel, skipId?: string): Song[] {
	const tracks: Song[] = [];
	for (const { video } of queueEntries(panel)) {
		if (video.video_id === skipId) continue;
		const artists = queueArtists(video);
		tracks.push({
			id: video.video_id,
			title: video.title.toString() || "Unknown Title",
			artist:
				artists.map((artist) => artist.name).join(", ") || video.author || "",
			artistId: artists.find((artist) => artist.id)?.id,
			artists: artists.length > 0 ? artists : undefined,
			thumbnail: hiResThumb(biggestThumb(video.thumbnail)?.url),
			duration: video.duration?.text,
		});
	}
	return tracks;
}

/**
 * Similar tracks to keep playing once the queue ends — YouTube Music's "Up
 * next" mix for the given video (automix fallback included). The current track
 * itself is skipped; returns `[]` when there is nothing to extend with.
 */
export async function getAutoplaySongs(videoId: string): Promise<Song[]> {
	try {
		const client = await getYoutubeClient();
		const panel = await client.music.getUpNext(videoId, true);
		return panelTracks(panel, videoId);
	} catch (error) {
		console.warn("[YuMusic] failed to load autoplay tracks:", error);
		return [];
	}
}

/** The context a mix queue starts from — the artist header's "Mix" button. */
export interface MixSource {
	videoId: string;
	playlistId: string;
	params?: string;
}

/** The "Mix" context an artist page header carries, when it has one. */
export function artistMixSource(header: Artist["header"]): MixSource | null {
	const button =
		header instanceof YTNodes.MusicImmersiveHeader
			? header.start_radio_button
			: null;
	const payload = button?.endpoint?.payload as
		| { videoId?: string; playlistId?: string; params?: string }
		| undefined;
	if (!payload?.videoId || !payload.playlistId) return null;
	return {
		videoId: payload.videoId,
		playlistId: payload.playlistId,
		params: payload.params,
	};
}

/**
 * Tracks of an artist mix started from its source context. The mix context
 * feeds the queue endpoint; returns `[]` when the queue cannot be loaded.
 */
export async function getMixSongs(mix: MixSource): Promise<Song[]> {
	try {
		const client = await getYoutubeClient();
		const response = await client.actions.execute("/next", {
			videoId: mix.videoId,
			playlistId: mix.playlistId,
			params: mix.params,
			enablePersistentPlaylistPanel: true,
			client: "YTMUSIC",
			parse: true,
		});
		const tab = response.contents_memo?.getType(YTNodes.Tab)?.[0];
		const queue = tab?.content?.is(YTNodes.MusicQueue) ? tab.content : null;
		const panel = queue?.content;
		return panel ? panelTracks(panel) : [];
	} catch (error) {
		console.warn("[YuMusic] failed to load mix queue:", error);
		return [];
	}
}

/**
 * Starts an artist's "Mix" (radio) by id. The mix context lives on the artist
 * page's header button (`RDEM…` playlist id plus seed) and cannot be derived
 * from the channel id — hence one artist fetch, paid only on demand. Callers
 * that already hold the artist page (the artist view) should use
 * `artistMixSource` + `getMixSongs` instead.
 */
export async function getArtistMixSongs(artistId: string): Promise<Song[]> {
	try {
		const client = await getYoutubeClient();
		const artist = await client.music.getArtist(artistId);
		const mix = artistMixSource(artist.header);
		return mix ? await getMixSongs(mix) : [];
	} catch (error) {
		console.warn("[YuMusic] failed to start artist mix:", error);
		return [];
	}
}
