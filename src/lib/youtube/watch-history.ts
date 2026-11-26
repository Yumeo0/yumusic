import { Constants } from "youtubei.js";
import type { YT } from "youtubei.js/web";

/** How often playback reports its watched range to YouTube's stats endpoint. */
export const WATCHTIME_PING_MS = 15_000;

// The stats endpoints identify the client that played the song. Report as the
// YouTube Music web player (WEB_REMIX), not plain YouTube, and post to the
// music host — matching music.youtube.com's own playback pings.
const STATS_CLIENT = {
	client_name: Constants.CLIENTS.YTMUSIC.NAME,
	client_version: Constants.CLIENTS.YTMUSIC.VERSION,
};

function musicStatsUrl(url: string): string {
	return url.replace(/^https:\/\/s\.youtube\.com/, "https://music.youtube.com");
}

/**
 * Registers the play with YouTube's playback stats — the same ping the web
 * player sends — so the song lands in the account's watch history.
 */
export function reportPlayback(videoInfo: YT.VideoInfo) {
	const tracking = videoInfo.page[0]?.playback_tracking;
	if (!tracking?.videostats_playback_url) return;
	void videoInfo.actions
		.stats(musicStatsUrl(tracking.videostats_playback_url), STATS_CLIENT, {
			cpn: videoInfo.cpn,
			c: STATS_CLIENT.client_name,
			fmt: "251",
			rtn: "0",
			rt: "0",
		})
		.catch((error) => {
			console.warn("[YuMusic] playback ping failed:", error);
		});
}

/**
 * Reports a watched media segment (`[start, end]`) to YouTube's watch-time
 * endpoint — the periodic ping the web player sends so the history entry
 * keeps its resume position. `final` closes the playback session.
 */
export function reportWatchTime(
	videoInfo: YT.VideoInfo,
	start: number,
	end: number,
	final: boolean,
) {
	const tracking = videoInfo.page[0]?.playback_tracking;
	if (!tracking?.videostats_watchtime_url) return;
	void videoInfo.actions
		.stats(musicStatsUrl(tracking.videostats_watchtime_url), STATS_CLIENT, {
			cpn: videoInfo.cpn,
			c: STATS_CLIENT.client_name,
			st: start.toFixed(3),
			et: end.toFixed(3),
			cmt: end.toFixed(3),
			final: final ? "1" : "0",
		})
		.catch((error) => {
			console.warn("[YuMusic] watch-time ping failed:", error);
		});
}
