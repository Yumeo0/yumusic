import { describe, expect, test } from "bun:test";
import {
	cleanUpTitle,
	detectTitleTags,
	displayTitle,
	formatArtistName,
	formatTitleParts,
	mergeArtistNames,
	remixAuthors,
	scrobbleTitle,
	stripArtistSuffix,
} from "./title";

/** Main title as cleaned by the display pipeline (original mode). */
const main = (title: string, artist?: string) =>
	formatTitleParts(title, "original", true, artist).main;

describe("noise, credit and decoration tails", () => {
	test("official audio labels are removed from uploader titles", () => {
		const title = "Fox Stevenson - Human In The Evening (Official Audio)";
		expect(main(title, "Fox Stevenson")).toBe("Human In The Evening");
		expect(scrobbleTitle(title, "Fox Stevenson").trackName).toBe(
			"Human In The Evening",
		);
		expect(displayTitle(title, "both", false, "Fox Stevenson")).toBe(title);
		for (const title of [
			"Song （Official Audio）",
			"Song - Official Audio",
			"Song (official audio) (Official Video)",
		]) {
			expect(main(title)).toBe("Song");
		}
		const parts = formatTitleParts(
			"Song (Official Audio) feat. Guest",
			"both",
			true,
		);
		expect(parts.main).toBe("Song");
		expect(parts.feats).toEqual(["Guest"]);
		expect(main("Song (Audio Mix)")).toBe("Song (Audio Mix)");
	});

	test("artist MV wrappers keep the quoted song title", () => {
		const title = "沙花叉クロヱ MV - 「擬態ごっこ」";
		const artist = "Chloe ch. 沙花叉クロヱ - holoX -, Sakamata Chloe";
		expect(formatTitleParts(title, "both", true, artist)).toEqual({
			main: "擬態ごっこ",
			feats: [],
			credits: [],
			coverArtists: [],
		});
		expect(main(title)).toBe("擬態ごっこ");
		expect(displayTitle(title, "original", true, artist)).toBe("擬態ごっこ");
		expect(scrobbleTitle(title, artist).trackName).toBe("擬態ごっこ");
		expect(displayTitle(title, "both", false, artist)).toBe(title);
	});

	test("quoted MV songs accept video-marker variants and keep feature credits", () => {
		for (const title of [
			"沙花叉クロヱ MV – 『擬態ごっこ』",
			"沙花叉クロヱ M/V — 「擬態ごっこ」",
			"沙花叉クロヱ Music Video - 「擬態ごっこ」",
			"沙花叉クロヱ Official Music Video - 「擬態ごっこ」",
		]) {
			expect(main(title)).toBe("擬態ごっこ");
		}
		const parts = formatTitleParts(
			"Artist MV - 「Song」 (feat. Guest)",
			"both",
			true,
		);
		expect(parts.main).toBe("Song");
		expect(parts.feats).toEqual(["Guest"]);
		expect(main("「擬態ごっこ」")).toBe("擬態ごっこ");
		expect(main("Artist MV - Song Without Quotes")).toBe(
			"Artist MV - Song Without Quotes",
		);
	});

	test("character EP videos use the quoted song as their title", () => {
		const title = 'Ellen EP - "Shark\'s Gotta Bite" | Zenless Zone Zero';
		expect(formatTitleParts(title, "both", true, "Zenless Zone Zero")).toEqual({
			main: "Shark's Gotta Bite",
			feats: [],
			credits: [],
			coverArtists: [],
		});
		expect(displayTitle(title, "both", false, "Zenless Zone Zero")).toBe(title);
	});

	test("character EP wrappers accept typographic quotes and dashes", () => {
		for (const title of [
			"Ellen EP – “Shark's Gotta Bite” | Zenless Zone Zero",
			'Ellen EP — "Shark\'s Gotta Bite" ｜ Zenless Zone Zero',
			'Ellen EP - "Shark\'s Gotta Bite"',
		]) {
			expect(main(title, "Zenless Zone Zero")).toBe("Shark's Gotta Bite");
		}
	});

	test("a pipe artist suffix does not consume an earlier song segment", () => {
		expect(
			stripArtistSuffix(
				'Character - "Song Name" | Game Channel',
				"Game Channel",
			),
		).toBe('Character - "Song Name"');
		expect(main('Artist - "Song Name"', "Another Artist")).toBe(
			'Artist - "Song Name"',
		);
		expect(main("The EP - A Song Without Quotes")).toBe(
			"The EP - A Song Without Quotes",
		);
		expect(main("A Song | Unrelated Text", "Game Channel")).toBe(
			"A Song | Unrelated Text",
		);
	});

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

	test("nested brackets in a cover credit are dropped whole", () => {
		// "月乃（『NEEDY GIRL OVERDOSE』主題歌）": the descriptor brackets wrap
		// the song's quoted name, so the performer is just "月乃".
		const parts = formatTitleParts(
			"❥ INTERNET OVERDOSE／Covered by 月乃（『NEEDY GIRL OVERDOSE』主題歌）",
			"original",
			true,
			"Tsukino",
		);
		expect(parts.main).toBe("❥ INTERNET OVERDOSE");
		expect(parts.coverArtists).toEqual(["月乃"]);
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

	test("original soundtrack qualifiers leave the song title and artist intact", () => {
		const title = "Oaths Unbent(Original Game Soundtrack)";
		expect(
			formatTitleParts(title, "original", true, "Wuthering Waves"),
		).toEqual({
			main: "Oaths Unbent",
			feats: [],
			credits: [],
			coverArtists: [],
		});
		expect(displayTitle(title, "both", true, "Wuthering Waves")).toBe(
			"Oaths Unbent",
		);
	});

	test("soundtrack qualifiers accept spacing, case and bracket variants", () => {
		for (const title of [
			"Oaths Unbent (Original Game Soundtrack)",
			"Oaths Unbent ( original game soundtrack )",
			"Oaths Unbent（Original Game Soundtrack）",
			"Oaths Unbent (Original Soundtrack)",
		]) {
			expect(main(title)).toBe("Oaths Unbent");
		}
	});

	test("soundtrack qualifiers revealed by video and feature tails are removed", () => {
		expect(
			main("Oaths Unbent(Original Game Soundtrack) (Official Video)"),
		).toBe("Oaths Unbent");
		const parts = formatTitleParts(
			"Oaths Unbent(Original Game Soundtrack) feat. Lime",
			"original",
			true,
		);
		expect(parts.main).toBe("Oaths Unbent");
		expect(parts.feats).toEqual(["Lime"]);
	});

	test("soundtrack cleanup preserves raw mode and meaningful version names", () => {
		const raw = "Oaths Unbent(Original Game Soundtrack)";
		expect(displayTitle(raw, "original", false)).toBe(raw);
		for (const title of [
			"Oaths Unbent (Original Mix)",
			"Oaths Unbent (Game Version)",
			"Song (Soundtrack of My Life)",
			"Original Game Soundtrack",
		]) {
			expect(main(title)).toBe(title);
		}
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

	test("remix bracket with possessive author and ascii video tail", () => {
		const parts = formatTitleParts(
			"Da Tweekaz - Moana (Caine & GPF's 200BPM Donk F**k Duck Piep Kick Remix) [Official Music Video]",
			"original",
			true,
			"Greazy Puzzy Fuckerz",
		);
		expect(parts.main).toBe("Da Tweekaz - Moana");
		expect(parts.credits).toEqual([{ tag: "remix", author: "Caine & GPF" }]);
	});

	test("remix author renders after the title", () => {
		const title =
			"Da Tweekaz - Moana (Caine & GPF's 200BPM Donk F**k Duck Piep Kick Remix) [Official Music Video]";
		const parts = formatTitleParts(
			title,
			"original",
			true,
			"Greazy Puzzy Fuckerz",
		);
		expect(remixAuthors(parts.credits)).toEqual(["Caine & GPF"]);
		expect(displayTitle(title, "original", true, "Greazy Puzzy Fuckerz")).toBe(
			"Da Tweekaz - Moana (Caine & GPF remix)",
		);
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

	test("ft. tail splits off and reveals trailing video-marker noise", () => {
		const parts = formatTitleParts(
			"HOP HOP (Music Video) - ft. Laffey II",
			"original",
			true,
			"Azur Lane Official - Yostar",
		);
		expect(parts.main).toBe("HOP HOP");
		expect(parts.feats).toEqual(["Laffey II"]);
		expect(formatTitleParts("Song (ft. A)", "original", true).feats).toEqual([
			"A",
		]);
	});

	test("feat list before the song separator keeps the song in the title", () => {
		const parts = formatTitleParts(
			"Shawn Wasabi + YDG feat. YUNG GEMMY - Burnt Rice (Aiobahn & Jh-Anu Remix) [PASS PogChamp!]",
			"original",
			true,
			"Nitsuga5124",
		);
		expect(parts.main).toBe("Shawn Wasabi + YDG - Burnt Rice");
		expect(parts.feats).toEqual(["YUNG GEMMY"]);
		expect(parts.credits).toEqual([
			{ tag: "remix", author: "Aiobahn & Jh-Anu" },
		]);
	});

	test("repeated title halves collapse to one", () => {
		expect(main("WataAme Pop - Wata Ame Pop")).toBe("WataAme Pop");
		expect(main("WataAme Pop - Wata Ame Pop", "Tsunomaki Watame")).toBe(
			"WataAme Pop",
		);
		// Real "Artist - Song" pairs are untouched.
		expect(cleanUpTitle("Da Tweekaz - Moana")).toBe("Da Tweekaz - Moana");
	});

	test("vocal credit splits off as a feature", () => {
		const parts = formatTitleParts(
			"Take Over (Vocal.湊あくあ)[Dyako Remix]",
			"original",
			true,
			"Dyako",
		);
		expect(parts.main).toBe("Take Over");
		expect(parts.feats).toEqual(["湊あくあ"]);
		expect(parts.credits).toEqual([{ tag: "remix", author: "Dyako" }]);
		expect(
			formatTitleParts("Song (歌：ななかぐら)", "original", true).feats,
		).toEqual(["ななかぐら"]);
	});

	test("a role-bracketed vocal credit survives an artist-name collision", () => {
		// The vocalist is also the track's artist here: "(Vocal.湊あくあ)" is
		// a feature credit, not an artist suffix to strip.
		const parts = formatTitleParts(
			"Take Over (Vocal.湊あくあ)[Dyako Remix]",
			"original",
			true,
			"湊あくあ",
		);
		expect(parts.main).toBe("Take Over");
		expect(parts.feats).toEqual(["湊あくあ"]);
		expect(parts.credits).toEqual([{ tag: "remix", author: "Dyako" }]);
	});

	test("artist - song with video marker cleans both", () => {
		expect(main("YOASOBI - アイドル (Official Video)", "YOASOBI")).toBe(
			"アイドル",
		);
	});

	test("artist - song with (cover) keeps the song", () => {
		const parts = formatTitleParts(
			"Bao - girls like me don't cry (cover)",
			"original",
			true,
			"Bao The Whale",
		);
		expect(parts.main).toBe("girls like me don't cry");
		// The uploader's short name is the artist, not a cover performer.
		expect(parts.coverArtists).toEqual([]);
		expect(parts.credits).toEqual([]);
	});

	test("channel-decorated artist prefix is stripped", () => {
		expect(main("Kobo Kanaeru - Overdose", "Kobo Kanaeru Ch. hololive")).toBe(
			"Overdose",
		);
	});

	test("leading bracket without tag keywords is kept", () => {
		expect(main("【推しの子】アイドル")).toBe("【推しの子】アイドル");
	});

	test("leading artist name tag is stripped", () => {
		expect(
			main("【ちくわ】人生マタタビ【オリジナル曲】", "ちくわちゃんねる"),
		).toBe("人生マタタビ");
		// Only the artist's own name tag goes; unrelated brackets stay.
		expect(main("【推しの子】アイドル", "YOASOBI")).toBe(
			"【推しの子】アイドル",
		);
		// The decorator-stripped form matches too.
		expect(
			main("【藍月なくる】ヘヴンリィ", "藍月なくる / Aitsuki Nakuru"),
		).toBe("ヘヴンリィ");
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

	test("channel aliases and group suffixes are dropped", () => {
		expect(formatArtistName("カグラナナchannel／ななかぐら")).toBe(
			"カグラナナ",
		);
		expect(formatArtistName("カグラナナchannel")).toBe("カグラナナ");
		expect(formatArtistName("Kanade Ch. 音乃瀬奏 ‐ ReGLOSS")).toBe("音乃瀬奏");
		// A glued marker is a decorator even when both halves are Latin.
		expect(formatArtistName("Towa Ch.Tokoyami Towa")).toBe("Tokoyami Towa");
		// A lowercase group tag marks the decorator with both halves Latin.
		expect(formatArtistName("Nanashi Mumei Ch. hololive-EN")).toBe(
			"Nanashi Mumei",
		);
		// Bracketed group tags are dropped as well.
		expect(formatArtistName("Elira Pendora 【NIJISANJI EN】")).toBe(
			"Elira Pendora",
		);
		// Also parenthesized tags on Latin names ("Apricot (Froot)").
		expect(formatArtistName("Apricot (Froot)")).toBe("Apricot");
		// Nested group brackets go with their parent span.
		expect(formatArtistName("月乃（『NEEDY GIRL OVERDOSE』主題歌）")).toBe(
			"月乃",
		);
		// Role credits in brackets are kept: they name a person.
		expect(formatArtistName("Ellen Joe (CV:Shion Wakayama)")).toBe(
			"Ellen Joe (CV:Shion Wakayama)",
		);
		expect(
			mergeArtistNames(
				[{ name: "Kanade Ch. 音乃瀬奏 ‐ ReGLOSS", id: "UC1" }],
				["音乃瀬奏"],
			),
		).toEqual([{ name: "音乃瀬奏", id: "UC1" }]);
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

	test("channel-decorated artist merges with the title credit", () => {
		const parts = formatTitleParts(
			"Overdose - Kobo Kanaeru (Cover)",
			"original",
			true,
			"Kobo Kanaeru Ch. hololive",
		);
		expect(parts.coverArtists).toEqual(["Kobo Kanaeru"]);
		expect(
			mergeArtistNames(
				[{ name: "Kobo Kanaeru Ch. hololive", id: "UC1" }],
				parts.coverArtists,
			),
		).toEqual([{ name: "Kobo Kanaeru", id: "UC1" }]);
		// A surname tail must not be mistaken for a channel decoration.
		expect(
			mergeArtistNames([{ name: "Charlie Ch. Brown" }], ["Brown"]),
		).toEqual([{ name: "Charlie Ch. Brown" }, { name: "Brown" }]);
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

	test("hashtag tag bracket before the title with a covered-by credit", () => {
		const title =
			"【#あの8人でナユタンメドレー】金星のダンス【covered by 鏑木ろこ / にじさんじ】";
		const parts = formatTitleParts(
			title,
			"original",
			true,
			"鏑木ろこ / Kaburaki Roco【にじさんじ】",
		);
		expect(parts.main).toBe("金星のダンス");
		expect(parts.coverArtists).toEqual(["鏑木ろこ", "にじさんじ"]);
		expect(parts.credits).toEqual([{ tag: "cover" }]);
	});

	test("hashtag tail stops at brackets instead of swallowing the title", () => {
		expect(cleanUpTitle("【#タグ】金星のダンス")).toBe("【#タグ】金星のダンス");
		expect(cleanUpTitle("Song #tag")).toBe("Song");
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

	test("cover marker with slash-credited performers", () => {
		const title = "月陽 -ツキアカリ-  みきとP (Cover) / VESPERBELL";
		const parts = formatTitleParts(title, "original", true, "VESPERBELL");
		expect(parts.main).toBe("月陽 -ツキアカリ-");
		expect(parts.coverArtists).toEqual(["VESPERBELL"]);
		// The tail parses even without artist metadata to anchor on.
		expect(main(title)).toBe("月陽 -ツキアカリ-");
		expect(main(title.toLowerCase())).toBe("月陽 -ツキアカリ-");
	});

	test("dash-credited original artist with slash-credited performers", () => {
		const parts = formatTitleParts(
			"SPECIALZ - King Gnu (Cover) / VESPERBELL ヨミ",
			"original",
			true,
			"VESPERBELL ヨミ",
		);
		expect(parts.main).toBe("SPECIALZ");
		expect(parts.coverArtists).toEqual(["VESPERBELL ヨミ"]);
		expect(main("天樂 - ゆうゆ (Cover) / VESPERBELL")).toBe("天樂");
	});

	test("plain cover marker with slash-credited performer", () => {
		const parts = formatTitleParts(
			"残酷な天使のテーゼ (Cover) / 花譜",
			"original",
			true,
			"花譜",
		);
		expect(parts.main).toBe("残酷な天使のテーゼ");
		expect(parts.coverArtists).toEqual(["花譜"]);
		// A Latin title must keep its last word: it is not a name credit.
		expect(main("A Cruel Angel's Thesis (Cover) / 花譜")).toBe(
			"A Cruel Angel's Thesis",
		);
		// A CJK title with an internal space is not an artist prefix either.
		expect(main("残酷な 天使のテーゼ (Cover) / 花譜")).toBe(
			"残酷な 天使のテーゼ",
		);
	});

	test("a reading dash closing the title is kept", () => {
		expect(cleanUpTitle("月陽 -ツキアカリ-")).toBe("月陽 -ツキアカリ-");
	});

	test("original-artist paren before a slash cover credit", () => {
		expect(main("モエチャッカファイア (弌誠) ／ダズビー COVER")).toBe(
			"モエチャッカファイア",
		);
		expect(main("Song (Original) / Performer COVER")).toBe("Song");
		// A non-name paren (feature/version) stays: it is not the original.
		expect(cleanUpTitle("Song (feat. X) / Performer COVER")).toBe(
			"Song (feat. X) / Performer COVER",
		);
	});

	test("leading performer list with the song title quoted", () => {
		const title =
			"藍月なくる×DECO*27×tepe「Hookah, whoo!」MV / ゲーム『Hookah Haze』主題歌";
		const parts = formatTitleParts(
			title,
			"original",
			true,
			"アニプレックス チャンネル",
		);
		expect(parts.main).toBe("Hookah, whoo!");
		expect(parts.coverArtists).toEqual(["藍月なくる", "DECO*27", "tepe"]);
		// The shape parses without artist metadata too.
		expect(main(title)).toBe("Hookah, whoo!");
	});

	test("trailing tag bracket with a marker on the performer", () => {
		const title =
			"【歌ってみた】私、アイドル宣言【ホロライブ/桃鈴ねね(cover)】";
		const parts = formatTitleParts(title, "original", true, "Nene Ch.桃鈴ねね");
		expect(parts.main).toBe("私、アイドル宣言");
		expect(parts.coverArtists).toEqual(["ホロライブ", "桃鈴ねね"]);
	});

	test("bracketed group tags in performer lists are dropped", () => {
		const parts = formatTitleParts(
			"【全力Chu!で】可愛くてごめん／Honeyworks covered by 博衣こより(hololive)【歌ってみた】",
			"original",
			true,
			"Koyori ch. 博衣こより - holoX -",
		);
		expect(parts.main).toBe("可愛くてごめん");
		expect(parts.coverArtists).toEqual(["博衣こより"]);
	});

	test("marker lists in brackets are filtered", () => {
		const title =
			"【Cover/１人で】光の旋律【歌ってみた/少し演奏してみた/ときのそら/ホロライブ】";
		const parts = formatTitleParts(title, "original", true, "TOKINOSORA");
		expect(parts.main).toBe("光の旋律");
		expect(parts.coverArtists).toEqual(["ときのそら", "ホロライブ"]);
		// The performers already sit in the artist row; the pill stays plain.
		expect(parts.credits).toEqual([{ tag: "cover" }]);
	});

	test("cover pill drops an author already in the artist row", () => {
		const parts = formatTitleParts(
			"Song (covered by 藍月なくる)",
			"original",
			true,
		);
		expect(parts.main).toBe("Song");
		expect(parts.coverArtists).toEqual(["藍月なくる"]);
		expect(parts.credits).toEqual([{ tag: "cover" }]);
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

	test("uploader titles keep their whole string in every mode", () => {
		// A reupload's raw title ("Artist - Song") is shown as-is: display
		// sites pass "both" for songs marked as uploads (no release behind
		// them), because the pair is not an original/translation form.
		const title = "かめりあ - Towards the Horizon";
		expect(displayTitle(title, "both", true)).toBe(title);
		// The default parse reads the same string as a dual title instead…
		expect(displayTitle(title, "original", true)).toBe("かめりあ");
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

	test("dash-credited performer before the cover marker", () => {
		const title = "flos (Remix ver.) / R Sound Design - むﾄ (cover)";
		const parts = formatTitleParts(title, "original", true, "Muto");
		expect(parts.main).toBe("flos");
		expect(parts.coverArtists).toEqual(["むﾄ"]);
		expect(detectTitleTags(title)).toContain("remix");
		expect(mergeArtistNames([{ name: "Muto" }], parts.coverArtists)).toEqual([
			{ name: "むﾄ", id: undefined },
		]);
	});
});

describe("scrobble titles", () => {
	test("the submitted track name is the parsed title, credits kept", () => {
		// The raw oEmbed/uploader title of a cover upload must not go out as-is.
		expect(scrobbleTitle("p.h. / 猫又おかゆ(cover)", "Nekomata Okayu")).toEqual(
			{
				main: "p.h.",
				feats: [],
				trackName: "p.h.",
			},
		);
		expect(
			scrobbleTitle("モードク - Moodoku", "Sakamata Chloe").trackName,
		).toBe("モードク");
		expect(scrobbleTitle("Song (feat. A & B)", "Artist").trackName).toBe(
			"Song (feat. A & B)",
		);
	});

	test("cleaning applies regardless of the display preference", () => {
		expect(scrobbleTitle("美人局 covered by 藍月なくる").trackName).toBe(
			"美人局",
		);
		expect(
			scrobbleTitle("【MV】怪物／KAIBUTSU (Cover)【FUWAMOCO】").trackName,
		).toBe("怪物");
	});
});
