import { describe, expect, test } from "bun:test";
import { cleanUpTitle, detectTitleTags, formatTitleParts } from "./title";

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
