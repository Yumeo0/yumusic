import { type Innertube, YTNodes } from "youtubei.js/web";
import { getYoutubeClient } from "../youtube/client-session";
import { youtubeFetch } from "../youtube/youtube-fetch";
import type { LrcLine, ProviderLyrics } from "./lyrics";

export async function getSongLyrics(
	videoId: string,
): Promise<ProviderLyrics | null> {
	const client = await getYoutubeClient();
	try {
		const browseId = await getLyricsBrowseId(client, videoId);
		if (browseId) {
			const synced = await fetchTimedLyrics(browseId);
			if (synced && synced.length > 0) {
				return { synced, plain: null, confirmed: true };
			}
		}
	} catch (error) {
		console.warn("Failed to get synced lyrics:", error);
	}
	try {
		// Unsynced fallback: plain description shelf (WEB_REMIX client).
		const shelf = await client.music.getLyrics(videoId);
		const text = shelf?.description?.toString();
		return text?.trim() ? { synced: null, plain: text, confirmed: true } : null;
	} catch (error) {
		console.warn("Failed to get lyrics:", error);
		return null;
	}
}

/** Finds the browse id of the track's lyrics page via the watch-next tabs. */
async function getLyricsBrowseId(
	client: Innertube,
	videoId: string,
): Promise<string | null> {
	const watchNextEndpoint = new YTNodes.NavigationEndpoint({
		watchNextEndpoint: { videoId },
	});
	const response = await watchNextEndpoint.call(client.actions, {
		client: "YTMUSIC",
		parse: true,
	});
	const tabs = response.contents_memo?.getType(YTNodes.Tab);
	const tab = tabs?.find(
		(t) =>
			t.endpoint.payload?.browseEndpointContextSupportedConfigs
				?.browseEndpointContextMusicConfig?.pageType ===
			"MUSIC_PAGE_TYPE_TRACK_LYRICS",
	);
	return tab?.endpoint.payload?.browseId ?? null;
}

// YouTube Music's iOS app client. Its browse responses are the only ones that
// include the timed-lyrics component with per-line cue ranges.
const IOS_MUSIC_CLIENT = { clientName: 26, clientVersion: "7.01.05" };

interface TimedLyricsLine {
	lyricLine: string;
	cueRange?: {
		startTimeMilliseconds: string;
		endTimeMilliseconds: string;
	};
}

interface TimedLyricsBrowseResponse {
	contents?: {
		elementRenderer?: {
			newElement?: {
				type?: {
					componentType?: {
						model?: {
							timedLyricsModel?: {
								lyricsData?: {
									timedLyricsData?: TimedLyricsLine[];
								};
							};
						};
					};
				};
			};
		};
	};
}

async function fetchTimedLyrics(browseId: string): Promise<LrcLine[] | null> {
	const response = await youtubeFetch(
		"https://music.youtube.com/youtubei/v1/browse?prettyPrint=false",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-YouTube-Client-Name": String(IOS_MUSIC_CLIENT.clientName),
				"X-YouTube-Client-Version": IOS_MUSIC_CLIENT.clientVersion,
			},
			body: JSON.stringify({
				browseId,
				context: { client: IOS_MUSIC_CLIENT },
			}),
		},
	);
	if (!response.ok) return null;
	const data = (await response.json()) as TimedLyricsBrowseResponse;
	const cues =
		data.contents?.elementRenderer?.newElement?.type?.componentType?.model
			?.timedLyricsModel?.lyricsData?.timedLyricsData;
	if (!Array.isArray(cues) || cues[0]?.cueRange == null) return null;
	const lines = cues
		.map((cue) => ({
			time: Number(cue.cueRange?.startTimeMilliseconds) / 1000,
			text: cue.lyricLine.trim(),
		}))
		.filter((line) => Number.isFinite(line.time));
	// Time the intro before the first vocal line from the start of the track
	// so the silence indicator runs there too.
	if (lines.length > 0 && lines[0].time > 0.3) {
		lines.unshift({ time: 0, text: "" });
	}
	return lines;
}
