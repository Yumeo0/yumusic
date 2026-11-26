import { expect, test } from "bun:test";
import type { Song } from "@/lib/music/song";
import { nextTrack, type UpcomingTracks } from "./next-track";

function song(id: string): Song {
	return { id, title: id, artist: "Artist", thumbnail: "" };
}

const [first, current, suggested] = ["first", "current", "suggested"].map(song);
const tracks: UpcomingTracks = {
	queue: [first, current],
	currentIndex: 1,
	currentSong: current,
	autoplayEnabled: true,
	autoplayTracks: [suggested],
	repeatMode: "off",
};

test("a natural repeat takes precedence over radio while skip promotes its next track", () => {
	const repeatOne = { ...tracks, repeatMode: "one" } as const;
	expect(nextTrack(repeatOne, "ended", false)).toEqual({
		kind: "repeat",
		song: current,
	});
	expect(nextTrack(repeatOne, "skip", false)).toEqual({
		kind: "autoplay",
		song: suggested,
		index: 2,
	});
});

test("finish-queue mode advances the existing list and stops before wrapping or radio", () => {
	const repeatAll = { ...tracks, repeatMode: "all" } as const;
	expect(
		nextTrack(
			{ ...repeatAll, currentIndex: 0, currentSong: first },
			"ended",
			true,
		),
	).toEqual({ kind: "queue", song: current, index: 1 });
	expect(nextTrack(repeatAll, "ended", false)).toEqual({
		kind: "queue",
		song: first,
		index: 0,
	});
	expect(nextTrack(repeatAll, "ended", true)).toBeNull();
	expect(nextTrack(tracks, "skip", true)).toBeNull();
});

test("requests a radio mix only when autoplay can extend the current track", () => {
	const ending = { ...tracks, autoplayTracks: [] };
	expect(nextTrack(ending, "ended", false)).toEqual({
		kind: "radio",
		song: current,
	});
	expect(
		nextTrack({ ...ending, autoplayEnabled: false }, "ended", false),
	).toBeNull();
});
