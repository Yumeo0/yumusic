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
 * uploader strings. A music video previews as the album track it resolves
 * to, since that is what playback will use. Resolves to null when neither
 * source can load the video (private, deleted, …).
 */
export async function getSongPreview(
	videoId: string,
): Promise<SongPreview | null> {
	const client = await getYoutubeClient();
	const meta = await getTrackMeta(videoId);
	// A music video resolves to its album track: the preview shows what will
	// be played — the song — not the video.
	const version = meta?.songVersion ?? null;
	const basic = version
		? null
		: await client
				.getBasicInfo(videoId)
				.then((info) => info.basic_info)
				.catch(() => null);
	if (!basic && !meta) return null;

	const description = version ? undefined : basic?.short_description?.trim();
	if (description) rememberSongDescription(videoId, description);

	const author = cleanAuthor(basic?.author);
	const artists: Array<{ name: string; id?: string }> = version?.artists?.length
		? version.artists
		: meta?.artists && meta.artists.length > 0
			? meta.artists
			: author
				? [
						{
							name: author,
							id: basic?.channel_id?.startsWith("UC")
								? basic.channel_id
								: undefined,
						},
					]
				: [];
	const song: Song = {
		id: version?.id ?? videoId,
		title:
			version?.title ?? meta?.originalTitle ?? basic?.title ?? "Unknown Title",
		artist:
			artists
				.map((artist) => artist.name)
				.filter(Boolean)
				.join(", ") || "Unknown Artist",
		artistId: artists.find((artist) => artist.id)?.id,
		artists: artists.length > 0 ? artists : undefined,
		thumbnail:
			version?.thumbnail ??
			hiResThumb(biggestThumb(basic?.thumbnail)?.url) ??
			`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
		duration:
			version?.duration ??
			(basic?.duration ? formatDuration(basic.duration) : undefined),
		// No release behind the video: its title is the uploader's own string.
		upload: version ? undefined : meta ? !meta.album : undefined,
	};
	const album = version?.album ?? meta?.album;
	return {
		// applySongDescription stores the text itself, so leave it off above.
		song: description ? applySongDescription(song, description) : song,
		album,
	};
}
