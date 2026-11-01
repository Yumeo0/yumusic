import { type YT, YTNodes } from "youtubei.js/web";
import type { Song } from "@/contexts/player-context";
import { biggestThumb, hiResThumb } from "../utils/utils";

/** Profile headers keep the avatar in front of a separate wide banner. */
export function channelProfileThumbnail(header: YTNodes.MusicVisualHeader) {
	return hiResThumb(biggestThumb(header.foreground_thumbnail)?.url) || null;
}

/** Public profile mixes are cards, omitted from the SDK's artist.sections. */
export function channelCardShelves(cards: Iterable<YTNodes.MusicCardShelf>) {
	const shelves = [];
	for (const card of cards) {
		const id = card.on_tap?.payload?.browseId;
		if (typeof id !== "string" || !/^(?:VL|MPR)[A-Za-z0-9_-]+$/.test(id))
			continue;
		shelves.push({
			title: card.header?.title?.toString() || "Featured",
			items: [
				{
					title: card.title.toString(),
					subtitle: card.subtitle.toString(),
					thumbnail:
						hiResThumb(biggestThumb(card.thumbnail?.contents)?.url) || null,
					link: `/playlists/${encodeURIComponent(id)}`,
				},
			],
		});
	}
	return shelves;
}

/** Keep normal YouTube channels in the same browsable result shape as artists. */
export function channelSearchEntries(
	channels: Iterable<YTNodes.Channel | YTNodes.GridChannel>,
) {
	const entries = [];
	const seen = new Set<string>();
	for (const channel of channels) {
		const id = channel.id || channel.author.id;
		if (!id?.startsWith("UC") || seen.has(id)) continue;
		seen.add(id);
		entries.push({
			kind: "artist" as const,
			id,
			name: channel.author.name || "Channel",
			subtitle: [
				"Channel",
				channel.author.url?.match(/\/@[^/?]+/)?.[0],
				channel.video_count?.toString(),
			]
				.filter(Boolean)
				.join(" · "),
			thumbnail: hiResThumb(biggestThumb(channel.author.thumbnails)?.url),
		});
	}
	return entries;
}

/** Channel uploads are playable with the channel's identity preserved. */
export function channelVideos(
	items: Iterable<YT.Channel["videos"][number]>,
	name: string,
	id: string,
): Song[] {
	const songs: Song[] = [];
	for (const item of items) {
		if (item.is(YTNodes.LockupView)) {
			if (item.content_type !== "VIDEO" || !item.content_id) continue;
			const thumbnail =
				item.content_image instanceof YTNodes.CollectionThumbnailView
					? item.content_image.primary_thumbnail
					: item.content_image;
			if (songs.some((song) => song.id === item.content_id)) continue;
			songs.push({
				id: item.content_id,
				title: item.metadata?.title?.toString() || "Untitled video",
				artist: name,
				artistId: id,
				artists: [{ name, id }],
				thumbnail: hiResThumb(biggestThumb(thumbnail?.image)?.url),
				duration: item.duration.text || undefined,
				upload: true,
			});
			continue;
		}
		if (!item.is(YTNodes.Video) && !item.is(YTNodes.GridVideo)) continue;
		const video = item.as(YTNodes.Video, YTNodes.GridVideo);
		const videoId = video.video_id;
		if (!videoId || songs.some((song) => song.id === videoId)) continue;
		songs.push({
			id: videoId,
			title: video.title.toString(),
			artist: name,
			artistId: id,
			artists: [{ name, id }],
			thumbnail: hiResThumb(biggestThumb(video.thumbnails)?.url),
			duration: video.duration?.text,
			upload: true,
		});
	}
	return songs;
}
