import { describe, expect, test } from "bun:test";
import { parseLyricSection } from "./sections";

describe("lyric section labels", () => {
	test("recognizes standalone sections, numbering, and performance directions", () => {
		for (const title of [
			"Intro",
			"Verse 2",
			"Pre-Chorus",
			"Chorus",
			"Bridge",
			"Outro",
			"Guitar Solo",
			"サビ",
		]) {
			expect(parseLyricSection(`[${title}]`)).toEqual({ title });
		}
		expect(parseLyricSection("  [ Chorus x2 ]  ")).toEqual({
			title: "Chorus x2",
		});
	});
	test("keeps performer credits separate from the section title", () => {
		expect(parseLyricSection("[Verse 1: Sān-Z & HOYO-MiX]")).toEqual({
			title: "Verse 1",
			credit: "Sān-Z & HOYO-MiX",
		});
	});
	test("leaves inline lyrics, empty labels, and multiple bracketed phrases intact", () => {
		for (const text of [
			"Sing [with me]",
			"[Intro] Sing along",
			"[]",
			"[   ]",
			"[Intro] [Verse 1]",
			"[first\nsecond]",
			"ordinary lyric",
			"",
		]) {
			expect(parseLyricSection(text)).toBeNull();
		}
	});
	test("does not mistake LRC timestamps or metadata for section headings", () => {
		for (const text of [
			"[00:12.30]",
			"[01:23]",
			"[ar:Artist]",
			"[ti:Song]",
			"[offset:100]",
		]) {
			expect(parseLyricSection(text)).toBeNull();
		}
	});
});
