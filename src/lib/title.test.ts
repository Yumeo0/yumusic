import { describe, expect, test } from "bun:test";
import {
	cleanUpTitle,
	detectTitleTags,
	formatArtistName,
	formatTitleParts,
	mergeArtistNames,
} from "./title";

/** Main title as cleaned by the display pipeline (original mode). */
const main = (title: string, artist?: string) =>
	formatTitleParts(title, "original", true, artist).main;

describe("noise, credit and decoration tails", () => {
	test("covered by tail", () => {
		expect(main("美人局 covered by 藍月なくる")).toBe("美人局");
	});

	test("bracketed covered-by tail", () => {
		expect(main("美人局 (covered by 藍月なくる)")).toBe("美人局");
	});

	test("glued slash covered-by without space after by", () => {
		expect(
			main(
				"BANG!BANG!BANG!/Covered by癒月ちょこ＆大空スバル＆姫森ルーナ＆獅白ぼたん",
			),
		).toBe("BANG!BANG!BANG!");
	});

	test("fullwidth slash covered-by with 歌ってみた tag", () => {
		expect(main("人マニア／Covered by紫咲シオン【歌ってみた】")).toBe(
			"人マニア",
		);
		expect(
			detectTitleTags("人マニア／Covered by紫咲シオン【歌ってみた】"),
		).toContain("cover");
	});

	test("slash-attached cover artist list", () => {
		const title =
			"メンヘラじゃないもん！ /Cover 湊あくあ/紫咲シオン【ホロライブ】";
		expect(main(title)).toBe("メンヘラじゃないもん！");
		expect(detectTitleTags(title)).toContain("cover");
	});

	test("cover performers are extracted for the artist row", () => {
		expect(
			formatTitleParts(
				"メンヘラじゃないもん！ /Cover 湊あくあ/紫咲シオン【ホロライブ】",
				"original",
				true,
				"湊あくあ",
			).coverArtists,
		).toEqual(["湊あくあ", "紫咲シオン"]);
		expect(
			formatTitleParts(
				"人マニア／Covered by紫咲シオン【歌ってみた】",
				"original",
				true,
			).coverArtists,
		).toEqual(["紫咲シオン"]);
		expect(
			formatTitleParts(
				"BANG!BANG!BANG!/Covered by癒月ちょこ＆大空スバル＆姫森ルーナ＆獅白ぼたん",
				"original",
				true,
			).coverArtists,
		).toEqual(["癒月ちょこ", "大空スバル", "姫森ルーナ", "獅白ぼたん"]);
		expect(
			formatTitleParts(
				"【チューリングラブ// Turing Love】Cover by Pomu Rainpuff, Elira Pendora",
				"original",
				true,
			).coverArtists,
		).toEqual(["Pomu Rainpuff", "Elira Pendora"]);
	});

	test("no cover credit yields no cover artists", () => {
		expect(
			formatTitleParts("Take Cover", "original", true).coverArtists,
		).toEqual([]);
		expect(
			formatTitleParts("Night Dancer (cover)", "original", true).coverArtists,
		).toEqual([]);
	});

	test("artist slash credit with (cover)", () => {
		expect(main("flos / R Sound Design (cover)")).toBe("flos");
	});

	test("artist dash credit with (cover)", () => {
		expect(main("flos - むﾄ (cover)")).toBe("flos");
	});

	test("bracketed cover tail", () => {
		expect(main("Night Dancer (cover)")).toBe("Night Dancer");
	});

	test("from-bracket tail", () => {
		expect(main('Lumiose City (From "Pokémon X & Y")')).toBe("Lumiose City");
	});

	test("spaced slash credit tail", () => {
		expect(main("セレナーデ / なとり")).toBe("セレナーデ");
	});

	test("fullwidth slash credit tail", () => {
		expect(main("snooze／眠雲ツクリ")).toBe("snooze");
	});

	test("translation pair via slash is kept", () => {
		expect(cleanUpTitle("夜駆け / Night Run")).toBe("夜駆け / Night Run");
	});

	test("decorative tails peel off", () => {
		expect(
			cleanUpTitle("失楽園 - Paradise Lost -『 失楽園 』MV【 #VocDuo2026 】"),
		).toBe("失楽園 - Paradise Lost");
	});

	test("slash inside a name is not treated as credit", () => {
		expect(main("AC/DC - Thunderstruck")).toBe("AC/DC - Thunderstruck");
		expect(main("24/7 Heaven")).toBe("24/7 Heaven");
	});

	test("feat tail splits off", () => {
		const parts = formatTitleParts("Song (feat. A & B)", "original", true);
		expect(parts.main).toBe("Song");
		expect(parts.feats).toEqual(["A", "B"]);
	});

	test("artist - song with video marker cleans both", () => {
		expect(main("YOASOBI - アイドル (Official Video)", "YOASOBI")).toBe(
			"アイドル",
		);
	});

	test("leading bracket without tag keywords is kept", () => {
		expect(main("【推しの子】アイドル")).toBe("【推しの子】アイドル");
	});

	test("latin bare cover word is kept", () => {
		expect(main("Take Cover")).toBe("Take Cover");
	});
});

describe("artist name romaji tails", () => {
	test("romaji half of a dual name is dropped", () => {
		expect(formatArtistName("眠雲ツクリ / NemukumoTsukuri")).toBe("眠雲ツクリ");
		expect(formatArtistName("ヨルシカ／Yorushika")).toBe("ヨルシカ");
		expect(formatArtistName("中田ヤスタカ - Yasutaka Nakata")).toBe(
			"中田ヤスタカ",
		);
		expect(formatArtistName("初音ミク / Hatsune Miku")).toBe("初音ミク");
	});

	test("romaji Ch. prefix is dropped", () => {
		expect(formatArtistName("Shion Ch. 紫咲シオン")).toBe("紫咲シオン");
		expect(formatArtistName("Miko Ch. さくらみこ")).toBe("さくらみこ");
		expect(formatArtistName("Hoshimachi Suisei Channel 星街すいせい")).toBe(
			"星街すいせい",
		);
		expect(formatArtistName("紫咲シオン Ch. Shion")).toBe("紫咲シオン");
	});

	test("single-language and Latin-first names are kept", () => {
		expect(formatArtistName("米津玄師")).toBe("米津玄師");
		expect(formatArtistName("Ado")).toBe("Ado");
		expect(formatArtistName("Kaf / 花譜")).toBe("Kaf / 花譜");
		expect(formatArtistName("花譜 / 理芽")).toBe("花譜 / 理芽");
		expect(formatArtistName("DJ 松永")).toBe("DJ 松永");
		expect(formatArtistName("Charlie Ch. Brown")).toBe("Charlie Ch. Brown");
	});

	test("cross-script artist duplicates merge to the original name", () => {
		expect(
			mergeArtistNames([{ name: "Minato Aqua" }], ["湊あくあ", "紫咲シオン"]),
		).toEqual([{ name: "湊あくあ", id: undefined }, { name: "紫咲シオン" }]);
		expect(
			mergeArtistNames(
				[{ name: "Minato Aqua", id: "UC1" }, { name: "紫咲シオン" }],
				["湊あくあ", "紫咲シオン"],
			),
		).toEqual([{ name: "湊あくあ", id: "UC1" }, { name: "紫咲シオン" }]);
		expect(
			mergeArtistNames([{ name: "Pomu Rainpuff" }], ["Elira Pendora"]),
		).toEqual([{ name: "Pomu Rainpuff" }, { name: "Elira Pendora" }]);
		expect(
			mergeArtistNames(
				[{ name: "Shion Ch. 紫咲シオン" }],
				["紫咲シオン", "湊あくあ"],
			),
		).toEqual([{ name: "紫咲シオン", id: undefined }, { name: "湊あくあ" }]);
	});
});

describe("cover markers and artist credit tails", () => {
	test("cover credit glued slash + MV tag + bare cover word", () => {
		expect(main("デーモンロード/ Kanaria 【オリジナルMV】cover")).toBe(
			"デーモンロード",
		);
		expect(
			detectTitleTags("デーモンロード/ Kanaria 【オリジナルMV】cover"),
		).toContain("cover");
	});

	test("leading cover tag bracket", () => {
		expect(main("【cover】 スロウダウナー(Slow Downer)")).toBe(
			"スロウダウナー(Slow Downer)",
		);
		expect(detectTitleTags("【cover】 スロウダウナー(Slow Downer)")).toContain(
			"cover",
		);
	});

	test("artist suffix + bootleg credit bracket", () => {
		const parts = formatTitleParts(
			"もぐもぐYUMMY！ - 猫又おかゆ (Omiyaクラブ Bootleg)",
			"original",
			true,
			"猫又おかゆ",
		);
		expect(parts.main).toBe("もぐもぐYUMMY！");
		expect(parts.credits).toEqual([{ tag: "remix", author: "Omiyaクラブ" }]);
		expect(
			detectTitleTags("もぐもぐYUMMY！ - 猫又おかゆ (Omiyaクラブ Bootleg)"),
		).toContain("remix");
	});

	test("歌ってみた counts as a cover and the credit tail is stripped", () => {
		expect(main("【歌ってみた】ラッシャイナ/柊マグネタイト")).toBe(
			"ラッシャイナ",
		);
		expect(
			detectTitleTags("【歌ってみた】ラッシャイナ/柊マグネタイト"),
		).toContain("cover");
	});

	test("mashup and official video parens are noise", () => {
		expect(main("Idols (EDM Mashup) (Official Video)")).toBe("Idols");
	});

	test("language cover qualifier tails are noise", () => {
		expect(main("G4L - English Cover")).toBe("G4L");
		expect(main("G4L / Japanese Cover")).toBe("G4L");
		expect(main("Song (English Cover)")).toBe("Song");
	});

	test("song titles containing a cover word are kept", () => {
		expect(main("Artist - Take Cover")).toBe("Artist - Take Cover");
		expect(main("Under Cover")).toBe("Under Cover");
	});

	test("english cover marker and ver. performer tail", () => {
		const title =
			"Invincible Rainbow Arrow (English Cover) ／ver. Elira Pendora";
		expect(main(title, "Elira Pendora 【NIJISANJI EN】")).toBe(
			"Invincible Rainbow Arrow",
		);
		expect(detectTitleTags(title)).toContain("cover");
	});

	test("ver. performer tail strips without artist metadata", () => {
		expect(main("Invincible Rainbow Arrow ／ver. Elira Pendora")).toBe(
			"Invincible Rainbow Arrow",
		);
	});

	test("bracketed dual title with glued cover-by tail", () => {
		const title =
			"【チューリングラブ// Turing Love】Cover by Pomu Rainpuff, Elira Pendora";
		expect(formatTitleParts(title, "both", true).main).toBe(
			"チューリングラブ// Turing Love",
		);
		expect(main(title)).toBe("チューリングラブ");
		expect(detectTitleTags(title)).toContain("cover");
	});

	test("leading MV tag, cover paren and channel tag bracket", () => {
		expect(main("【MV】怪物／KAIBUTSU (Cover)【FUWAMOCO】")).toBe("怪物");
		expect(cleanUpTitle("【MV】怪物／KAIBUTSU (Cover)【FUWAMOCO】")).toBe(
			"怪物／KAIBUTSU",
		);
		expect(
			detectTitleTags("【MV】怪物／KAIBUTSU (Cover)【FUWAMOCO】"),
		).toContain("cover");
	});

	test("leading english cover tag + artist bracket suffix", () => {
		expect(
			main(
				"【ENGLISH COVER】Love Me, Love Me, Love Me (Nerissa Ravencroft)",
				"Nerissa Ravencroft",
			),
		).toBe("Love Me, Love Me, Love Me");
		expect(
			detectTitleTags(
				"【ENGLISH COVER】Love Me, Love Me, Love Me (Nerissa Ravencroft)",
			),
		).toContain("cover");
	});
});

describe("VTuber cover title shapes", () => {
	test("wrapped title + marker + cast bracket", () => {
		const title =
			"【オリジナルMV】「クノイチでも恋がしたい」歌ってみた【神楽めあ× 湊あくあ】";
		const parts = formatTitleParts(title, "original", true, "湊あくあ");
		expect(parts.main).toBe("クノイチでも恋がしたい");
		expect(parts.coverArtists).toEqual(["神楽めあ", "湊あくあ"]);
	});

	test("wrapped title with original-artist slash credit + cast bracket", () => {
		const title =
			"【オリジナルMV】「ソラシド～ねえねえ～／Buono!」【神楽めあ/湊あくあ】";
		const parts = formatTitleParts(title, "original", true, "湊あくあ");
		expect(parts.main).toBe("ソラシド～ねえねえ～");
		expect(parts.coverArtists).toEqual(["神楽めあ", "湊あくあ"]);
	});

	test("flavor tag brackets and trailing 歌ってみた marker", () => {
		expect(main("【可愛く】きゅうくらりん／湊あくあ【歌ってみた】")).toBe(
			"きゅうくらりん",
		);
		expect(main("【玉ねぎ】寝起きヤシの木／湊あくあ【歌ってみた】")).toBe(
			"寝起きヤシの木",
		);
		expect(main("【陰キャが】可愛くてごめん／湊あくあ【歌ってみた】")).toBe(
			"可愛くてごめん",
		);
		expect(main("【メン限】夜撫でるメノウ　歌ってみた Ver.湊あくあ")).toBe(
			"夜撫でるメノウ",
		);
	});

	test("leading brackets without cover context are kept", () => {
		expect(main("【推しの子】アイドル")).toBe("【推しの子】アイドル");
		expect(main("【東方】Bad Apple!! 歌ってみた")).toBe("Bad Apple!!");
	});

	test("performer list before the cover marker", () => {
		const title = "ダーリンダンス 湊あくあ×猫又おかゆ(cover)";
		const parts = formatTitleParts(title, "original", true, "Minato Aqua");
		expect(parts.main).toBe("ダーリンダンス");
		expect(parts.coverArtists).toEqual(["湊あくあ", "猫又おかゆ"]);
		expect(
			mergeArtistNames([{ name: "Minato Aqua" }], parts.coverArtists),
		).toEqual([{ name: "湊あくあ", id: undefined }, { name: "猫又おかゆ" }]);
	});
});
