import { file } from "bun";

const UNRELEASED =
	"## [Unreleased]\n\n### Features\n\n### Improvements\n\n### Bug fixes\n\n";

function releaseVersion(value: string): string {
	const version = value.replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(`Invalid release version: ${value}`);
	return version;
}

function section(markdown: string, name: string) {
	const text = markdown.replace(/\r\n/g, "\n");
	const headings = [...text.matchAll(/^##[ \t]+\[([^\]\n]+)\][^\n]*$/gm)];
	const matches = headings.filter((heading) => heading[1] === name);
	if (matches.length !== 1)
		throw new Error(`CHANGELOG.md must contain exactly one [${name}] section`);
	const heading = matches[0];
	const index = headings.indexOf(heading);
	const start = heading.index;
	const bodyStart = start + heading[0].length;
	const end = headings[index + 1]?.index ?? text.length;
	return { text, start, end, body: text.slice(bodyStart, end) };
}

/** Omit empty template categories and author-only comments from published notes. */
function cleanNotes(body: string): string {
	return body
		.replace(/<!--[\s\S]*?-->/g, "")
		.split(/(?=^###[ \t]+)/m)
		.map((part) => part.trim())
		.filter((part) => part.replace(/^###[^\n]*/m, "").trim())
		.join("\n\n");
}

/** The same reviewed Markdown is used by Forgejo and the in-app updater. */
export function releaseNotes(markdown: string, value: string): string {
	const name = value === "Unreleased" ? value : releaseVersion(value);
	const notes = cleanNotes(section(markdown, name).body);
	if (!notes)
		throw new Error(
			`Add user-facing notes to CHANGELOG.md [${name}] before releasing`,
		);
	return notes.replace(/^###[ \t]+/gm, "## ");
}

/** Freeze the reviewed notes into the version committed and tagged by release.ts. */
export function prepareReleaseChangelog(
	markdown: string,
	value: string,
	date: string,
): string {
	const version = releaseVersion(value);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		new Date(date).toISOString().slice(0, 10) !== date
	) {
		throw new Error(`Invalid release date: ${date}`);
	}
	const unreleased = section(markdown, "Unreleased");
	if (
		[...unreleased.text.matchAll(/^##[ \t]+\[([^\]\n]+)\]/gm)].some(
			(heading) => heading[1] === version,
		)
	) {
		throw new Error(`CHANGELOG.md already contains [${version}]`);
	}
	// Validate before changing any version files or creating a tag.
	releaseNotes(markdown, "Unreleased");
	const notes = cleanNotes(unreleased.body);
	return (
		`${unreleased.text.slice(0, unreleased.start)}${UNRELEASED}## [${version}] - ${date}\n\n${notes}\n\n${unreleased.text.slice(unreleased.end)}`.trimEnd() +
		"\n"
	);
}

// Read-only preview; no Forgejo credentials or publishing required.
if (import.meta.main) {
	const markdown = await file(
		new URL("../CHANGELOG.md", import.meta.url),
	).text();
	console.log(releaseNotes(markdown, process.argv[2] ?? "Unreleased"));
}
