import { YTNodes } from "youtubei.js/web";

export function* queueEntries(panel: YTNodes.PlaylistPanel) {
	for (const entry of panel.contents) {
		if (entry.is(YTNodes.PlaylistPanelVideo)) yield { video: entry };
		else if (entry.is(YTNodes.PlaylistPanelVideoWrapper) && entry.primary)
			yield { video: entry.primary, wrapper: entry };
	}
}

export function queueArtists(video: YTNodes.PlaylistPanelVideo) {
	return (video.artists ?? [])
		.filter((artist) => artist.name)
		.map((artist) => ({
			name: artist.name,
			id: artist.channel_id?.startsWith("UC") ? artist.channel_id : undefined,
		}));
}
