import { describe, expect, test } from "bun:test";
import type { YTNodes } from "youtubei.js/web";
import {
	artistListOf,
	artistNames,
	artistSubtitle,
	extractVideoId,
	findVideoId,
} from "./youtube.utils";

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
		expect(artistNames(item)).toBe("Fox Stevenson");
		expect(artistListOf(item).map((artist) => artist.name)).toEqual([
			"Fox Stevenson",
		]);
	});
	test("plain subtitle fallback also excludes statistics", () => {
		const item = {
			subtitle: "Video • Fox Stevenson • 12M views",
		} as unknown as YTNodes.MusicResponsiveListItem;
		expect(artistNames(item)).toBe("Fox Stevenson");
		expect(artistListOf(item).map((artist) => artist.name)).toEqual([
			"Fox Stevenson",
		]);
	});
});

describe("extractVideoId", () => {
	test("watch URLs, with and without extra params", () => {
		expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
			"dQw4w9WgXcQ",
		);
		expect(
			extractVideoId(
				"https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ",
			),
		).toBe("dQw4w9WgXcQ");
		expect(extractVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
			"dQw4w9WgXcQ",
		);
	});

	test("short, shorts, live and embed links", () => {
		expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc123")).toBe(
			"dQw4w9WgXcQ",
		);
		expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(
			"dQw4w9WgXcQ",
		);
		expect(
			extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ?feature=share"),
		).toBe("dQw4w9WgXcQ");
		expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
			"dQw4w9WgXcQ",
		);
	});

	test("scheme-less links", () => {
		expect(extractVideoId("youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
		expect(extractVideoId("youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
			"dQw4w9WgXcQ",
		);
	});

	test("rejects other hosts, invalid ids and plain text", () => {
		expect(
			extractVideoId("https://example.com/watch?v=dQw4w9WgXcQ"),
		).toBeNull();
		expect(extractVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
		expect(extractVideoId("https://www.youtube.com/watch")).toBeNull();
		expect(extractVideoId("just some text")).toBeNull();
	});
});

describe("findVideoId", () => {
	test("finds the link inside pasted text", () => {
		expect(
			findVideoId("check this out https://youtu.be/dQw4w9WgXcQ it's great"),
		).toBe("dQw4w9WgXcQ");
		expect(
			findVideoId("song: https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=abc"),
		).toBe("dQw4w9WgXcQ");
	});

	test("tolerates trailing punctuation and wrapper brackets", () => {
		expect(findVideoId("(https://youtu.be/dQw4w9WgXcQ).")).toBe("dQw4w9WgXcQ");
		expect(
			findVideoId("see <https://www.youtube.com/watch?v=dQw4w9WgXcQ>"),
		).toBe("dQw4w9WgXcQ");
	});

	test("returns null without a YouTube link", () => {
		expect(findVideoId("no links here")).toBeNull();
		expect(findVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
	});
});
