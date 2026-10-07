import type { Song } from "@/contexts/player-context";
import { applySongDescription } from "@/lib/utils/description";
import { biggestThumb, formatDuration, hiResThumb } from "@/lib/utils/utils";
import { rememberSongDescription } from "./song-description";
import { getTrackMeta, getYoutubeClient } from "./youtube-client";

/** A pasted link's song plus the album metadata resolved for it. */
export interface SongPreview {
	song: Song;
	album?: { name: string; id?: string };
}

/** Uploader channels are named "<Artist> - Topic"; drop that suffix. */
function cleanAuthor(name: string | null | undefined): string | undefined {
	const cleaned = name?.replace(/\s*-\s*Topic$/i, "").trim();
	return cleaned || undefined;
}

/**
 * Full song data for a pasted video link: the player response supplies the
 * artwork, length and description, and the up-next queue supplies the artist
 * entities with their channel ids (a plain uploader name is the fallback).
 * The uploader's original oEmbed title beats the player title, which can be
 * locale-influenced, and the description is applied exactly like playback
 * does — so the preview shows the parsed title and credits, not the raw
 * uploader strings. Resolves to null when neither source can load the video
 * (private, deleted, …).
 */
export async function getSongPreview(
	videoId: string,
): Promise<SongPreview | null> {
	const client = await getYoutubeClient();
	const [basic, meta] = await Promise.all([
		client
			.getBasicInfo(videoId)
			.then((info) => info.basic_info)
			.catch(() => null),
		getTrackMeta(videoId),
	]);
	if (!basic && !meta) return null;

	const description = basic?.short_description?.trim();
	if (description) rememberSongDescription(videoId, description);

	const author = cleanAuthor(basic?.author);
	const artists: Array<{ name: string; id?: string }> =
		meta?.artists && meta.artists.length > 0
			? meta.artists
			: author
				? [{ name: author }]
				: [];
	const song: Song = {
		id: videoId,
		title: meta?.originalTitle ?? basic?.title ?? "Unknown Title",
		artist:
			artists
				.map((artist) => artist.name)
				.filter(Boolean)
				.join(", ") || "Unknown Artist",
		artistId: artists.find((artist) => artist.id)?.id,
		artists: artists.length > 0 ? artists : undefined,
		thumbnail:
			hiResThumb(biggestThumb(basic?.thumbnail)?.url) ||
			`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
		duration: basic?.duration ? formatDuration(basic.duration) : undefined,
	};
	return {
		// applySongDescription stores the text itself, so leave it off above.
		song: description ? applySongDescription(song, description) : song,
		album: meta?.album,
	};
}
