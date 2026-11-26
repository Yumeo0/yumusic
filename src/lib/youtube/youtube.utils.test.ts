import { describe, expect, test } from "bun:test";
import type { YTNodes } from "youtubei.js/web";
import { songFromMusicRow } from "./music-row";
import { artistSubtitle } from "./youtube.utils";

describe("song subtitle credits", () => {
	test("keeps artists without type labels, counts, or durations", () => {
		expect(artistSubtitle("Video • Fox Stevenson • 1.4M views • 5:21")).toBe(
			"Fox Stevenson",
		);
		expect(artistSubtitle("Song · Artist · 2026 · 1,234 views")).toBe("Artist");
		expect(artistSubtitle("1 view")).toBe("");
		expect(artistSubtitle("Views")).toBe("Views");
		expect(artistSubtitle("3OH!3")).toBe("3OH!3");
	});
	test("responsive video info columns never credit view counts as artists", () => {
		const item = {
			flex_columns: [
				{},
				{
					title: {
						runs: [
							"Video",
							" · ",
							"Fox Stevenson",
							" · ",
							"1.4M views",
							" · ",
							"5:21",
						].map((text) => ({ text })),
					},
				},
			],
		} as unknown as YTNodes.MusicResponsiveListItem;
		expect(songFromMusicRow(item)).toMatchObject({
			artist: "Fox Stevenson",
			artists: [{ name: "Fox Stevenson" }],
		});
	});
	test("plain subtitle fallback also excludes statistics", () => {
		const item = {
			subtitle: "Video • Fox Stevenson • 12M views",
		} as unknown as YTNodes.MusicResponsiveListItem;
		expect(songFromMusicRow(item)).toMatchObject({
			artist: "Fox Stevenson",
			artists: [{ name: "Fox Stevenson" }],
		});
	});
});
