import { YTNodes } from "youtubei.js/web";
import { getYoutubeClient } from "./client-session";
import { findKey } from "./response-data";

export type SongRating = "like" | "dislike" | null;

/**
 * Sets the signed-in account's rating for a video; null clears it. YouTube
 * treats repeating the current rating as a no-op, so callers can toggle
 * without tracking the previous state.
 *
 * youtubei.js' InteractionManager passes the video id as a bare string, which
 * the like endpoints now reject ("Invalid value at 'target'"); the API wants
 * a `LikeTarget` object (`{ videoId }`). The endpoints are called directly
 * with the YouTube Music context, matching its web player.
 */
export async function setSongRating(
	videoId: string,
	rating: SongRating,
): Promise<void> {
	const client = await getYoutubeClient();
	if (!client.session.logged_in) {
		throw new Error("You must be signed in to rate songs.");
	}
	const endpoint =
		rating === "like"
			? "/like/like"
			: rating === "dislike"
				? "/like/dislike"
				: "/like/removelike";
	const response = await client.actions.execute(endpoint, {
		target: { videoId },
		client: "YTMUSIC",
	});
	if (!response.success) {
		throw new Error(`Rating update failed (HTTP ${response.status_code})`);
	}
}

/**
 * Reads the account's current rating for a video. The web watch-next response
 * omits the rating, but the TV client's transport controls carry a
 * `likeButtonRenderer` whose `likeStatus` is the account's rating. Resolves
 * to `undefined` when it cannot be determined (signed out or no button), so
 * callers can leave the buttons neutral.
 */
export async function getSongRating(
	videoId: string,
): Promise<SongRating | undefined> {
	try {
		const client = await getYoutubeClient();
		if (!client.session.logged_in) return undefined;
		const response = await client.actions.execute("/next", {
			videoId,
			client: "TV",
		});
		const likeButton = findKey(response.data, "likeButtonRenderer") as
			| { likeStatus?: string }
			| undefined;
		return ratingFromStatus(likeButton?.likeStatus);
	} catch (error) {
		console.warn("[YuMusic] failed to read the song rating:", error);
		return undefined;
	}
}

function ratingFromStatus(status: string | undefined): SongRating | undefined {
	switch (status) {
		case "LIKE":
			return "like";
		case "DISLIKE":
			return "dislike";
		case "INDIFFERENT":
			return null;
		default:
			return undefined;
	}
}

/** List responses carry the account's rating in a LikeButton, avoiding extra requests. */
export function songRatingEntry(item: YTNodes.MusicResponsiveListItem) {
	const button = item.menu?.top_level_buttons?.find(
		(entry): entry is YTNodes.LikeButton => entry.is(YTNodes.LikeButton),
	);
	const id = button?.target?.video_id;
	const rating = ratingFromStatus(button?.like_status);
	return id && rating !== undefined ? { id, rating } : null;
}
