import { describe, expect, test } from "bun:test";
import {
	hideHomeSection,
	isHomeSectionHidden,
	normalizeHiddenHomeSections,
	normalizeHomeSectionTitle,
	showHomeSection,
	TODAYS_BIGGEST_HITS,
} from "./home-sections";

describe("home section titles", () => {
	test("normalizes case, whitespace and curly apostrophes", () => {
		expect(normalizeHomeSectionTitle("  Today’s Biggest Hits ")).toBe(
			"today's biggest hits",
		);
	});

	test("matches hidden titles case-insensitively", () => {
		expect(
			isHomeSectionHidden("TODAY'S BIGGEST HITS", ["Today's biggest hits"]),
		).toBe(true);
		expect(isHomeSectionHidden("Mixed for you", ["Today's biggest hits"])).toBe(
			false,
		);
	});

	test("hides a title once and ignores blank values", () => {
		const hidden = hideHomeSection([], "Today's biggest hits");
		expect(hidden).toEqual(["Today's biggest hits"]);

		expect(hideHomeSection(hidden, "  today's biggest hits  ")).toEqual(hidden);
		expect(hideHomeSection(hidden, "   ")).toEqual(hidden);
		expect(hideHomeSection(hidden, "Mixed for you")).toEqual([
			"Today's biggest hits",
			"Mixed for you",
		]);
	});

	test("restores a title case-insensitively", () => {
		expect(
			showHomeSection(
				["Today's biggest hits", "Mixed for you"],
				"TODAY'S BIGGEST HITS",
			),
		).toEqual(["Mixed for you"]);
	});
});

describe("normalizeHiddenHomeSections", () => {
	test("filters invalid entries and de-duplicates titles", () => {
		expect(
			normalizeHiddenHomeSections([
				"  Mixed for you  ",
				42,
				"",
				null,
				"mixed FOR you",
			]),
		).toEqual(["Mixed for you"]);
	});

	test("migrates the old Today's biggest hits flag", () => {
		expect(normalizeHiddenHomeSections(undefined, true)).toEqual([
			TODAYS_BIGGEST_HITS,
		]);
		expect(normalizeHiddenHomeSections(undefined, false)).toEqual([]);
	});

	test("prefers an explicit hidden list over the legacy flag", () => {
		expect(normalizeHiddenHomeSections(["Charts"], true)).toEqual(["Charts"]);
		expect(normalizeHiddenHomeSections([], true)).toEqual([]);
	});
});
