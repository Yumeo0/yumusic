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

	test("theme-song lines outrank product-sheet title keys", () => {
		expect(
			parseDescriptionCredits(
				"主題歌「Hookah, whoo!」\n歌：藍月なくる\n\n＜製品情報＞\nタイトル：　　Hookah Haze（フーカーヘイズ）",
			),
		).toEqual({ title: "Hookah, whoo!", artist: "藍月なくる" });
		expect(parseDescriptionCredits("テーマソング：Hookah, whoo!")?.title).toBe(
			"Hookah, whoo!",
		);
	});

	test("reads a work-by-artist prose line against the uploader title", () => {
		const description = "Eine Kleine Nachtmusik by Wolfgang Amadeus Mozart";
		expect(
			parseDescriptionCredits(description, "Eine Kleine Nachtmusik - Mozart"),
		).toEqual({
			title: "Eine Kleine Nachtmusik",
			artist: "Wolfgang Amadeus Mozart",
		});
		// Without a matching uploader title the prose is not a credit.
		expect(parseDescriptionCredits(description)).toBeNull();
		expect(parseDescriptionCredits(description, "Some Other Song")).toBeNull();
		// Production chatter stays out, even when a word overlaps.
		expect(
			parseDescriptionCredits("Mixed by Someone", "Mixed Signals - Artist"),
		).toBeNull();
	});

	test("collects every performer line, for collabs", () => {
		expect(
			parseDescriptionCredits(
				"Vocal：獅白ぼたん\n @ShishiroBotan \nVocal：角巻わため\nhttps://twitter.com/tsunomakiwatame",
			)?.artist,
		).toBe("獅白ぼたん, 角巻わため");
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

	test("keeps title performers when the description replaces the title", () => {
		const updated = applySongDescription(
			song({
				title:
					"藍月なくる×DECO*27×tepe「Hookah, whoo!」MV / ゲーム『Hookah Haze』主題歌",
				artist: "アニプレックス チャンネル",
				artistId: "UC14QT5j2nQI8lKBCGtrrBQA",
				artists: [
					{
						name: "アニプレックス チャンネル",
						id: "UC14QT5j2nQI8lKBCGtrrBQA",
					},
				],
			}),
			"主題歌「Hookah, whoo!」\n歌：藍月なくる\n\nタイトル：　　Hookah Haze（フーカーヘイズ）",
		);
		expect(updated.title).toBe("Hookah, whoo!");
		expect(updated.artists?.map((artist) => artist.name)).toEqual([
			"藍月なくる",
			"DECO*27",
			"tepe",
		]);
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

	test("adopts a multi-name vocal credit the title doesn't mention", () => {
		const updated = applySongDescription(
			song({
				title: "リップシンク - Lip‐Sync",
				artist: "La+ Darknesss",
				artistId: "UCd5jlP-h6jXEU0TKFRNdIng",
				artists: [{ name: "La+ Darknesss", id: "UCd5jlP-h6jXEU0TKFRNdIng" }],
			}),
			"Vocal: 紫咲シオン × ラプラス・ダークネス\n@MurasakiShion @LaplusDarknesss\nLyrics & Music: DECO*27",
		);
		expect(updated.title).toBe("リップシンク - Lip‐Sync");
		expect(updated.artist).toBe("紫咲シオン, ラプラス・ダークネス");
		expect(updated.artists).toEqual([
			{ name: "紫咲シオン" },
			{ name: "ラプラス・ダークネス", id: "UCd5jlP-h6jXEU0TKFRNdIng" },
		]);
	});

	test("carries stored ids over through handles and profile links", () => {
		// PAKU: each vocal line carries its own link; both vocalists are
		// adopted and the stored Watame id moves to 角巻わため.
		const paku = applySongDescription(
			song({
				title: "PAKU / 角巻わため×獅白ぼたん(Cover)",
				artist: "Tsunomaki Watame",
				artistId: "UCX2NCyh8ipCoydn1iKWyM_Q",
				artists: [{ name: "Tsunomaki Watame", id: "UCX2NCyh8ipCoydn1iKWyM_Q" }],
			}),
			"Vocal：獅白ぼたん\n @ShishiroBotan \nVocal：角巻わため\nhttps://twitter.com/tsunomakiwatame",
		);
		expect(paku.artists).toEqual([
			{ name: "獅白ぼたん" },
			{ name: "角巻わため", id: "UCX2NCyh8ipCoydn1iKWyM_Q" },
		]);

		// 妄想アスパルテーム: the twitter link sits on the credit line itself.
		const aspa = applySongDescription(
			song({
				title: "妄想アスパルテーム／湊あくあ (cover)",
				artist: "Minato Aqua",
				artistId: "UC1opHUrw8rvnsadT-iGp7Cg",
				artists: [{ name: "Minato Aqua", id: "UC1opHUrw8rvnsadT-iGp7Cg" }],
			}),
			"♡Vocal：湊あくあ　https://twitter.com/minatoaqua",
		);
		expect(aspa.artists).toEqual([
			{ name: "湊あくあ", id: "UC1opHUrw8rvnsadT-iGp7Cg" },
		]);
	});

	test("reads labelled channel links under a credit line", () => {
		// ギラギラ: the stored entity id moves through the twitter slug.
		const updated = applySongDescription(
			song({
				title: "ギラギラ - Ado / 町田ちま(Cover)",
				artist: "Machita Chima",
				artistId: "UCeiwyXe4tpmuq7IYBLeb8aw",
				artists: [{ name: "Machita Chima", id: "UCeiwyXe4tpmuq7IYBLeb8aw" }],
			}),
			[
				"◆Vocal：町田ちま",
				"[YouTube] https://www.youtube.com/channel/UCo7TRj3cS-f_1D9ZDmuTsjw",
				"[Twitter] https://twitter.com/chima_machita23",
			].join("\n"),
		);
		expect(updated.artists).toEqual([
			{ name: "町田ちま", id: "UCeiwyXe4tpmuq7IYBLeb8aw" },
		]);

		// Without a stored id, the channel URL links the name directly.
		const linked = applySongDescription(
			song({
				title: "ギラギラ - Ado / 町田ちま(Cover)",
				artist: "町田ちま",
				artists: [{ name: "町田ちま" }],
			}),
			"◆Vocal：町田ちま\n[YouTube] https://www.youtube.com/channel/UCo7TRj3cS-f_1D9ZDmuTsjw",
		);
		expect(linked.artists).toEqual([
			{ name: "町田ちま", id: "UCo7TRj3cS-f_1D9ZDmuTsjw" },
		]);
	});

	test("adopts a composer from a work-by-artist prose line", () => {
		const updated = applySongDescription(
			song({
				title: "Eine Kleine Nachtmusik - Mozart",
				artist: "AllClassicalMusic",
				artistId: "UCMLnGKHk2Gi_vq82IhSgHkQ",
				artists: [
					{ name: "AllClassicalMusic", id: "UCMLnGKHk2Gi_vq82IhSgHkQ" },
				],
			}),
			"Eine Kleine Nachtmusik by Wolfgang Amadeus Mozart",
		);
		expect(updated.title).toBe("Eine Kleine Nachtmusik");
		expect(updated.artist).toBe("Wolfgang Amadeus Mozart");
		expect(updated.artists).toEqual([{ name: "Wolfgang Amadeus Mozart" }]);
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

	test("flags a leading performer list the channel does not explain", () => {
		expect(
			titleNeedsDescription(
				song({
					title:
						"藍月なくる×DECO*27×tepe「Hookah, whoo!」MV / ゲーム『Hookah Haze』主題歌",
					artist: "アニプレックス チャンネル",
					artists: [{ name: "アニプレックス チャンネル" }],
				}),
			),
		).toBe(true);
		// A channel that is one of the listed performers needs no lookup.
		expect(
			titleNeedsDescription(
				song({
					title: "藍月なくる×DECO*27×tepe「Hookah, whoo!」MV",
					artist: "藍月なくる",
					artists: [{ name: "藍月なくる" }],
				}),
			),
		).toBe(false);
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

	test("ignores channel-decorated credits the prefix pipeline strips", () => {
		expect(
			titleNeedsDescription(
				song({
					title: "Kobo Kanaeru - Overdose",
					artist: "Kobo Kanaeru Ch. hololive",
					artists: [{ name: "Kobo Kanaeru Ch. hololive" }],
				}),
			),
		).toBe(false);
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
