import { describe, expect, test } from "bun:test";
import { extractVideoId, findVideoId } from "./youtube.utils";

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
