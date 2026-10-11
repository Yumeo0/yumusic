import { describe, expect, test } from "bun:test";
import type { Song } from "@/contexts/player-context";
import { needsUploadCheck } from "./song-description";

function song(overrides: Partial<Song>): Song {
	return {
		id: "nMEG65kBDDk",
		title: "Some Song",
		artist: "Some Channel",
		thumbnail: "",
		...overrides,
	};
}

describe("needsUploadCheck", () => {
	test("flags dual-shaped titles without a verdict", () => {
		// The reupload case: "Artist - Song" reads as original/translation.
		expect(
			needsUploadCheck(song({ title: "かめりあ - Towards the Horizon" })),
		).toBe(true);
		expect(
			needsUploadCheck(song({ title: "本能スピード - Instinctive Speed" })),
		).toBe(true);
		expect(needsUploadCheck(song({ title: "夜駆け / Night Run" }))).toBe(true);
	});

	test("plain single-language titles don't need a check", () => {
		expect(needsUploadCheck(song({ title: "Lemon" }))).toBe(false);
		expect(needsUploadCheck(song({ title: "Da Tweekaz - Moana" }))).toBe(false);
		expect(needsUploadCheck(song({ title: "" }))).toBe(false);
	});

	test("a recorded verdict skips the check", () => {
		const title = "かめりあ - Towards the Horizon";
		expect(needsUploadCheck(song({ title, upload: true }))).toBe(false);
		expect(needsUploadCheck(song({ title, upload: false }))).toBe(false);
	});
});
