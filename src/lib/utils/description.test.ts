import { describe, expect, test } from "bun:test";
import type { Song } from "@/contexts/player-context";
import {
	applySongDescription,
	parseDescriptionCredits,
	titleNeedsDescription,
} from "./description";

const song = (overrides: Partial<Song> = {}): Song => ({
	id: "ltHkpEmf_mo",
	title: "Nameless - Milk Crown on Sonnetica (Lyrics Romaji)",
	artist: "Doga",
	artistId: "UCXNXUcLHN8cVSGi9COGdL0g",
	artists: [{ name: "Doga", id: "UCXNXUcLHN8cVSGi9COGdL0g" }],
	thumbnail: "https://i.ytimg.com/vi/ltHkpEmf_mo/hq720.jpg",
	...overrides,
});

describe("parseDescriptionCredits", () => {
	test("reads the singer/song sheet", () => {
		expect(
			parseDescriptionCredits(
				"Singer: Nameless\nSong: Milk Crown On Sonnetica (Original - Hatsune miku)",
			),
		).toEqual({
			title: "Milk Crown On Sonnetica",
			artist: "Nameless",
		});
	});

	test("supports full-width colons and Japanese keys", () => {
		expect(parseDescriptionCredits("歌：ななかぐら\n曲名：夜駆け")).toEqual({
			artist: "ななかぐら",
			title: "夜駆け",
		});
	});

	test("drops the original-work note from the song title", () => {
		expect(
			parseDescriptionCredits("Song: X (Original: Hatsune Miku)")?.title,
		).toBe("X");
		expect(parseDescriptionCredits("曲名：X（原曲：初音ミク）")?.title).toBe(
			"X",
		);
	});

	test("cleans links and handles off credit values", () => {
		expect(
			parseDescriptionCredits(
				"Vocals: vally.exe https://twitter.com/vallyutaite @vallyutaite",
			)?.artist,
		).toBe("vally.exe");
	});

	test("reads decorated credit lines", () => {
		expect(parseDescriptionCredits("★ Singer: Nameless")?.artist).toBe(
			"Nameless",
		);
	});

	test("ignores production credit rolls without song fields", () => {
		expect(
			parseDescriptionCredits(
				"Director: Aruvn\nCamera: Someone\nMV: Another Person",
			),
		).toBeNull();
	});

	test("ignores prose longer than a credit value", () => {
		const long = "Singer: ".concat("x".repeat(200));
		expect(parseDescriptionCredits(long)).toBeNull();
	});

	test("returns null without a description", () => {
		expect(parseDescriptionCredits(undefined)).toBeNull();
		expect(parseDescriptionCredits("")).toBeNull();
	});
});

describe("applySongDescription", () => {
	test("adopts the description's singer and song when the title credits them", () => {
		const updated = applySongDescription(
			song(),
			"Singer: Nameless\nSong: Milk Crown On Sonnetica (Original - Hatsune miku)",
		);
		expect(updated.title).toBe("Milk Crown On Sonnetica");
		expect(updated.artist).toBe("Nameless");
		expect(updated.artistId).toBeUndefined();
		expect(updated.artists).toEqual([{ name: "Nameless" }]);
		expect(updated.description).toContain("Singer: Nameless");
	});

	test("keeps the channel artist for production credit rolls", () => {
		const updated = applySongDescription(
			song({
				title: "HOP HOP (Music Video) - ft. Laffey II",
				artist: "Azur Lane Official - Yostar",
				artistId: "UCPeJaqP6WgxUVDcpYkXZKMQ",
				artists: [
					{
						name: "Azur Lane Official - Yostar",
						id: "UCPeJaqP6WgxUVDcpYkXZKMQ",
					},
				],
			}),
			"Title: HOP HOP\nVocals: vally.exe",
		);
		expect(updated.title).toBe("HOP HOP");
		expect(updated.artist).toBe("Azur Lane Official - Yostar");
		expect(updated.artistId).toBe("UCPeJaqP6WgxUVDcpYkXZKMQ");
	});

	test("keeps the channel id when the description names the same artist", () => {
		const updated = applySongDescription(
			song({
				title: "Doga - Song Name",
				artist: "Doga",
				artists: [{ name: "Doga", id: "UC1" }],
			}),
			"Singer: Doga\nSong: Song Name",
		);
		expect(updated.title).toBe("Song Name");
		expect(updated.artist).toBe("Doga");
		expect(updated.artistId).toBe("UC1");
	});

	test("replaces the artist when a singer-only description names the title prefix", () => {
		const updated = applySongDescription(song(), "Singer: Nameless");
		expect(updated.title).toBe(
			"Nameless - Milk Crown on Sonnetica (Lyrics Romaji)",
		);
		expect(updated.artist).toBe("Nameless");
	});

	test("stores a description without recognized credits", () => {
		const updated = applySongDescription(song(), "just some video notes");
		expect(updated.title).toBe(song().title);
		expect(updated.artist).toBe("Doga");
		expect(updated.description).toBe("just some video notes");
	});

	test("is idempotent for the same description", () => {
		const first = applySongDescription(song(), "Singer: Nameless");
		expect(applySongDescription(first, "Singer: Nameless")).toBe(first);
	});

	test("stores long descriptions truncated but parses them in full", () => {
		const long = `Singer: Nameless\n${"f".repeat(5000)}`;
		const updated = applySongDescription(song(), long);
		expect(updated.description?.length).toBe(4000);
		expect(updated.artist).toBe("Nameless");
	});
});

describe("titleNeedsDescription", () => {
	test("flags a leading credit the channel does not explain", () => {
		expect(titleNeedsDescription(song())).toBe(true);
	});

	test("ignores credits that match a known artist", () => {
		expect(
			titleNeedsDescription(
				song({
					title: "Doga - Milk Crown on Sonnetica",
					artist: "Doga",
					artists: [{ name: "Doga" }],
				}),
			),
		).toBe(false);
		// Trailing " - <artist>" credit.
		expect(
			titleNeedsDescription(
				song({
					title: "Overdose - Kobo Kanaeru",
					artist: "Kobo Kanaeru Ch. hololive",
					artists: [{ name: "Kobo Kanaeru Ch. hololive" }],
				}),
			),
		).toBe(false);
	});

	test("flags channel-decorated credits the prefix pipeline cannot strip", () => {
		expect(
			titleNeedsDescription(
				song({
					title: "Kobo Kanaeru - Overdose",
					artist: "Kobo Kanaeru Ch. hololive",
					artists: [{ name: "Kobo Kanaeru Ch. hololive" }],
				}),
			),
		).toBe(true);
	});

	test("ignores dual titles and version/feat tails", () => {
		expect(titleNeedsDescription(song({ title: "夜駆け - Night Run" }))).toBe(
			false,
		);
		expect(titleNeedsDescription(song({ title: "Song - ft. Laffey II" }))).toBe(
			false,
		);
		expect(
			titleNeedsDescription(
				song({ title: "Song (Music Video) - ft. Laffey II" }),
			),
		).toBe(false);
		expect(titleNeedsDescription(song({ title: "Song Name - Live" }))).toBe(
			false,
		);
	});

	test("ignores titles without a credit separator", () => {
		expect(
			titleNeedsDescription(song({ title: "Milk Crown on Sonnetica" })),
		).toBe(false);
		expect(
			titleNeedsDescription(
				song({
					title: "AC/DC - Thunderstruck",
					artist: "AC/DC",
					artists: [{ name: "AC/DC" }],
				}),
			),
		).toBe(false);
		expect(titleNeedsDescription(song({ title: "24/7 Heaven" }))).toBe(false);
	});

	test("ignores full-width slash credits that name the artist", () => {
		expect(
			titleNeedsDescription(
				song({
					title: "snooze／眠雲ツクリ",
					artist: "眠雲ツクリ",
					artists: [{ name: "眠雲ツクリ" }],
				}),
			),
		).toBe(false);
	});
});
