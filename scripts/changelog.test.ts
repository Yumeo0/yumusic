import { describe, expect, test } from "bun:test";
import { prepareReleaseChangelog, releaseNotes } from "./changelog";

const markdown = `# Changelog

## [Unreleased]

<!-- Notes for maintainers only. -->
### Features

- Repeat a song or an entire playlist.

### Improvements

### Bug fixes

- Signing in no longer reuses expired cookies.

## [0.5.1] - 2026-10-24

### Features

- Find lyrics through Genius.
`;

describe("user-facing release notes", () => {
	test("extracts only the requested version and omits empty sections and comments", () => {
		expect(releaseNotes(markdown, "Unreleased")).toBe(`## Features

- Repeat a song or an entire playlist.

## Bug fixes

- Signing in no longer reuses expired cookies.`);
		expect(releaseNotes(markdown, "v0.5.1")).toBe(
			"## Features\n\n- Find lyrics through Genius.",
		);
	});

	test("handles Windows line endings", () => {
		expect(releaseNotes(markdown.replaceAll("\n", "\r\n"), "Unreleased")).toBe(
			releaseNotes(markdown, "Unreleased"),
		);
	});

	test("freezes notes into the release and preserves the historical entries", () => {
		const result = prepareReleaseChangelog(markdown, "0.5.2", "2026-10-31");
		expect(result).toContain("## [0.5.2] - 2026-10-31");
		expect(result.indexOf("## [Unreleased]")).toBeLessThan(
			result.indexOf("## [0.5.2]"),
		);
		expect(releaseNotes(result, "v0.5.2")).toBe(
			releaseNotes(markdown, "Unreleased"),
		);
		expect(releaseNotes(result, "0.5.1")).toBe(releaseNotes(markdown, "0.5.1"));
		expect(() => releaseNotes(result, "Unreleased")).toThrow(
			"Add user-facing notes",
		);
	});

	test("rejects missing, duplicate, or empty notes rather than publishing commit history", () => {
		expect(() => releaseNotes(markdown, "0.9.0")).toThrow("exactly one");
		expect(() =>
			releaseNotes(`${markdown}\n## [0.5.1]\n- Duplicate`, "0.5.1"),
		).toThrow("exactly one");
		expect(() =>
			releaseNotes(
				"## [Unreleased]\n### Features\n<!-- later -->\n### Bug fixes\n",
				"Unreleased",
			),
		).toThrow("Add user-facing notes");
	});

	test("rejects overwriting history or invalid release metadata", () => {
		expect(() =>
			prepareReleaseChangelog(markdown, "0.5.1", "2026-10-31"),
		).toThrow("already contains");
		expect(() =>
			prepareReleaseChangelog(markdown, "not-a-version", "2026-10-31"),
		).toThrow("Invalid release version");
		expect(() =>
			prepareReleaseChangelog(markdown, "0.5.2", "2026-02-30"),
		).toThrow("Invalid release date");
	});
});
