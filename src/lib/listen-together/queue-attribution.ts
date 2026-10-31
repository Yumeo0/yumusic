import type { Song } from "@/contexts/player-context";
import type { RoomAction } from "./guest-permissions";

/** Attribution belongs to a queue occurrence, never to the song's global metadata. */
export function attributeSongs(songs: Song[], username: string): Song[] {
	return songs.map((song) => ({ ...song, addedBy: username }));
}

/** Only the host stamps guest actions, using the admitted participant's profile. */
export function attributeAction(
	action: RoomAction,
	username: string,
): RoomAction {
	switch (action.type) {
		case "autoplay":
			return { ...action, addedBy: username };
		case "play":
		case "playNext":
			return { ...action, song: attributeSongs([action.song], username)[0] };
		case "add":
		case "playQueue":
			return { ...action, songs: attributeSongs(action.songs, username) };
		default:
			return action;
	}
}
