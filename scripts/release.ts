// `bun release patch|minor|major [--no-push]`
//
// Bumps the app version everywhere it lives (package.json, the Tauri config,
// Cargo.toml and Cargo.lock), commits it as "chore: release vX.Y.Z", tags the
// commit and pushes the branch and tag so the release workflow builds and
// publishes the signed bundles and updater manifest. Pass --no-push to keep
// the commit and tag local.
import { file, fileURLToPath, write } from "bun";
import { prepareReleaseChangelog } from "./changelog";
import { runGit } from "./git";
import { addMetainfoRelease } from "./metainfo";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUMPS = ["patch", "minor", "major"] as const;
type Bump = (typeof BUMPS)[number];

function fail(message: string): never {
	console.error(`\n${message}\n`);
	process.exit(1);
}

/** Runs git and captures its output. */
function git(...args: string[]): string {
	return runGit(args, { cwd: ROOT });
}

/** Runs git with its output going straight to the terminal. */
function gitInherit(...args: string[]) {
	runGit(args, { cwd: ROOT, inherit: true });
}

function bumpVersion(version: string, bump: Bump): string {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) fail(`Cannot parse version "${version}" — expected X.Y.Z`);
	const [major, minor, patch] = match.slice(1).map(Number);
	if (bump === "major") return `${major + 1}.0.0`;
	if (bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

async function updateJsonVersion(path: URL, version: string) {
	const json = (await file(path).json()) as Record<string, unknown>;
	json.version = version;
	await write(path, `${JSON.stringify(json, null, "\t")}\n`);
}

const args = process.argv.slice(2);
const bump = args.find((arg): arg is Bump =>
	(BUMPS as readonly string[]).includes(arg),
);
const push = !args.includes("--no-push");

if (!bump) {
	console.log("Usage: bun release <patch|minor|major> [--no-push]");
	process.exit(1);
}
if (git("status", "--porcelain")) {
	fail("Working tree is not clean — commit or stash your changes first.");
}

const packagePath = new URL("../package.json", import.meta.url);
const current = ((await file(packagePath).json()) as { version: string })
	.version;
const version = bumpVersion(current, bump);
const tag = `v${version}`;
if (git("tag", "-l", tag)) {
	fail(`Tag ${tag} already exists.`);
}

const date = new Date().toISOString().slice(0, 10);
const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
const changelog = prepareReleaseChangelog(
	await file(changelogPath).text(),
	version,
	date,
);

await updateJsonVersion(packagePath, version);
await updateJsonVersion(
	new URL("../src-tauri/tauri.conf.json", import.meta.url),
	version,
);

const cargoPath = new URL("../src-tauri/Cargo.toml", import.meta.url);
const cargo = (await file(cargoPath).text()).replace(
	/^version = "[^"]*"/m,
	`version = "${version}"`,
);
await write(cargoPath, cargo);

const lockPath = new URL("../src-tauri/Cargo.lock", import.meta.url);
const lock = await file(lockPath).text();
const updatedLock = lock.replace(
	/(\[\[package\]\]\r?\nname = "app"\r?\nversion = ")[^"]+(?=")/,
	`$1${version}`,
);
if (updatedLock === lock) {
	fail("Could not find the app package in src-tauri/Cargo.lock.");
}
await write(lockPath, updatedLock);

const metainfoPath = new URL(
	"../src-tauri/linux/dev.yumeo.yumusic.metainfo.xml",
	import.meta.url,
);
await write(
	metainfoPath,
	addMetainfoRelease(await file(metainfoPath).text(), version, date),
);
await write(changelogPath, changelog);

gitInherit(
	"add",
	"CHANGELOG.md",
	"package.json",
	"src-tauri/tauri.conf.json",
	"src-tauri/Cargo.toml",
	"src-tauri/Cargo.lock",
	"src-tauri/linux/dev.yumeo.yumusic.metainfo.xml",
);
gitInherit("commit", "-m", `chore: release ${tag}`);
gitInherit("tag", tag);

console.log(`\nReleased ${tag} (was ${current}).`);
if (push) {
	gitInherit("push", "origin", "HEAD");
	gitInherit("push", "origin", tag);
	console.log(`Pushed ${tag} — the release workflow is running.`);
} else {
	console.log(
		`Push it to trigger the release workflow:\n\n  git push origin HEAD\n  git push origin ${tag}\n`,
	);
}
