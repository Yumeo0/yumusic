// Publishes Tauri bundles to Forgejo releases and maintains the updater's
// `latest.json` manifest. Driven by the release workflow:
//
//   bun scripts/forgejo-release.ts publish   # once per platform build job
//   bun scripts/forgejo-release.ts latest    # once after all platform jobs
//
// Required environment:
//   FORGEJO_URL         base URL, e.g. https://git.yumeo.dev
//   FORGEJO_REPOSITORY  owner/repo, e.g. Yumeo/YuMusic
//   FORGEJO_TOKEN       API token (the workflow's GITHUB_TOKEN)
//   RELEASE_TAG         tag being released, e.g. v0.2.0
//   RELEASE_VERSION     tag without the leading "v"
//   BUNDLE_DIR          Tauri bundle output (publish only)
//   UPDATER_TARGET      override the updater platform key (defaults to the
//                       build machine's platform)
//   RELEASE_NOTES       optional override of the generated commit notes

import { file, Glob, write } from "bun";
import { runGit } from "./git";

/** Artifact paths can come from either a Windows or Linux build runner. */
function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

interface ForgejoAsset {
	id: number;
	name: string;
	browser_download_url: string;
}

interface ForgejoRelease {
	id: number;
	tag_name: string;
	body?: string;
	assets?: ForgejoAsset[];
}

interface UpdaterPlatform {
	signature: string;
	url: string;
}

const url = (process.env.FORGEJO_URL ?? "").replace(/\/+$/, "");
const repository = process.env.FORGEJO_REPOSITORY ?? "";
const token = process.env.FORGEJO_TOKEN ?? "";
const tag = process.env.RELEASE_TAG ?? "";
const version = process.env.RELEASE_VERSION ?? "";

if (!url || !repository || !token || !tag || !version) {
	throw new Error(
		"FORGEJO_URL, FORGEJO_REPOSITORY, FORGEJO_TOKEN, RELEASE_TAG and RELEASE_VERSION are required",
	);
}

const api = `${url}/api/v1/repos/${repository}`;
const authHeaders = { Authorization: `token ${token}` };

async function apiFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const response = await fetch(`${api}${path}`, {
		...init,
		headers: { ...authHeaders, ...init.headers },
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`${init.method ?? "GET"} ${path} failed (${response.status}): ${body.slice(0, 300)}`,
		);
	}
	return response;
}

async function findRelease(name: string): Promise<ForgejoRelease | null> {
	const response = await fetch(
		`${api}/releases/tags/${encodeURIComponent(name)}`,
		{ headers: authHeaders },
	);
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(
			`GET release ${name} failed (${response.status}): ${await response.text()}`,
		);
	}
	return (await response.json()) as ForgejoRelease;
}

/** Release notes from the commits since the previous v* tag. */
function releaseNotes(): string {
	let previous = "";
	try {
		const tags = runGit(["tag", "-l", "v*", "--sort=-v:refname"])
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
		previous = tags.find((name) => name !== tag) ?? "";
	} catch {
		// Best effort: fall back to the full history.
	}
	const range = previous ? `${previous}..${tag}` : tag;
	let log = "";
	try {
		log = runGit(["log", range, "--pretty=format:- %s"]);
	} catch {
		// ignore
	}
	return `Release ${tag}\n\n## Changes\n${log || "- No changes recorded."}`;
}

async function ensureRelease(
	name: string,
	body: string,
): Promise<ForgejoRelease> {
	const existing = await findRelease(name);
	if (existing) return existing;
	const response = await apiFetch("/releases", {
		method: "POST",
		body: JSON.stringify({
			tag_name: name,
			name,
			body,
			draft: false,
			prerelease: false,
		}),
		headers: { "Content-Type": "application/json" },
	});
	return (await response.json()) as ForgejoRelease;
}

/** Uploads a file, replacing any asset that already carries its name. */
async function upload(
	release: ForgejoRelease,
	path: string,
	name = basename(path),
) {
	const existing = release.assets?.find((asset) => asset.name === name);
	if (existing) {
		// Forgejo nests attachments under the release (GitHub's top-level
		// /releases/assets/{id} route does not exist here).
		await apiFetch(`/releases/${release.id}/assets/${existing.id}`, {
			method: "DELETE",
		});
		release.assets = release.assets?.filter(
			(asset) => asset.id !== existing.id,
		);
	}
	const form = new FormData();
	form.append("attachment", new File([await file(path).arrayBuffer()], name));
	const response = await apiFetch(
		`/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
		{ method: "POST", body: form },
	);
	const asset = (await response.json()) as ForgejoAsset;
	release.assets = [...(release.assets ?? []), asset];
}

async function uploadJson(
	release: ForgejoRelease,
	name: string,
	value: unknown,
) {
	const temporary = `${process.env.BUNDLE_DIR ?? "."}/${name}`;
	await write(temporary, `${JSON.stringify(value, null, 2)}\n`);
	await upload(release, temporary, name);
}

const ARCH: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };

/** The Tauri updater target key of the running machine. */
function updaterTarget(): string {
	const arch = ARCH[process.arch] ?? process.arch;
	if (process.platform === "win32") return `windows-${arch}`;
	if (process.platform === "darwin") return `darwin-${arch}`;
	return `linux-${arch}`;
}

/**
 * Among the signed updater bundles prefer the installable archive Tauri
 * generates for each platform (the AppImage/NSIS versions can also be
 * signed, but the updater consumes the compressed artifact).
 */
const ARTIFACT_PREFERENCE = [
	/\.AppImage\.tar\.gz$/,
	/\.app\.tar\.gz$/,
	/\.nsis\.zip$/,
	/-setup\.exe$/,
	/\.msi\.zip$/,
	/\.AppImage$/,
];

function pickArtifact(signatures: string[]): string {
	for (const pattern of ARTIFACT_PREFERENCE) {
		const match = signatures.find((file) => pattern.test(file));
		if (match) return match;
	}
	return signatures[0];
}

/**
 * The signed artifacts of this release. The Cargo cache restores earlier
 * runs' bundle directories, so artifacts from previous versions are filtered
 * out by filename — otherwise an old installer could be picked for the
 * updater manifest (and re-published on every run).
 */
async function signedArtifacts(
	bundleDir: string,
	releaseVersion: string,
): Promise<string[]> {
	const glob = new Glob("**/*.sig");
	const signatures: string[] = [];
	for await (const file of glob.scan({ cwd: bundleDir, absolute: true })) {
		signatures.push(file);
	}
	const escaped = releaseVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const versioned = new RegExp(`[_-]${escaped}[_.-]`);
	return signatures
		.map((file) => file.slice(0, -4))
		.filter((file) => versioned.test(basename(file)))
		.sort((a, b) => a.localeCompare(b));
}

/** One platform's build: upload its bundles and record the updater entry. */
async function publish() {
	const bundleDir = process.env.BUNDLE_DIR ?? "src-tauri/target/release/bundle";
	const release = await ensureRelease(
		tag,
		process.env.RELEASE_NOTES ?? releaseNotes(),
	);
	const target = process.env.UPDATER_TARGET ?? updaterTarget();
	const artifacts = await signedArtifacts(bundleDir, version);
	if (artifacts.length === 0) {
		throw new Error(
			`No signed ${version} updater artifacts found in ${bundleDir}`,
		);
	}

	for (const artifact of artifacts) {
		await upload(release, artifact);
		await upload(release, `${artifact}.sig`);
	}

	const chosen = pickArtifact(artifacts);
	const signature = (await file(`${chosen}.sig`).text()).trim();
	console.log(`Updater artifact for ${target}: ${basename(chosen)}`);
	await uploadJson(release, `platform-${target}.json`, {
		version,
		notes: release.body ?? `Release ${tag}`,
		pub_date: new Date().toISOString(),
		platforms: {
			[target]: {
				signature,
				url: `${url}/${repository}/releases/download/${tag}/${encodeURIComponent(basename(chosen))}`,
			},
		},
	});
}

function isNewerVersion(candidate: string, current: string): boolean {
	const parse = (value: string) =>
		value
			.replace(/^v/, "")
			.split(/[.-]/)
			.map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(candidate);
	const b = parse(current);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return false;
}

/** Merge every platform entry from the tagged release into latest.json. */
async function latest() {
	const release = await findRelease(tag);
	if (!release) throw new Error(`Release ${tag} not found`);
	const platforms: Record<string, UpdaterPlatform> = {};
	for (const asset of release.assets ?? []) {
		if (!/^platform-.+\.json$/.test(asset.name)) continue;
		const response = await fetch(asset.browser_download_url, {
			headers: authHeaders,
		});
		if (!response.ok) {
			throw new Error(`Could not download ${asset.name} (${response.status})`);
		}
		const manifest = (await response.json()) as {
			platforms?: Record<string, UpdaterPlatform>;
		};
		Object.assign(platforms, manifest.platforms ?? {});
	}
	if (Object.keys(platforms).length === 0) {
		throw new Error(`No platform manifests found on release ${tag}`);
	}

	const latestRelease = await ensureRelease(
		"latest",
		`Rolling updater manifest for ${release.tag_name}.`,
	);
	const current = latestRelease.assets?.find(
		(asset) => asset.name === "latest.json",
	);
	const currentVersion = current ? await currentManifestVersion(current) : null;
	if (currentVersion && !isNewerVersion(version, currentVersion)) {
		console.log(
			`latest.json is already at ${currentVersion} — skipping ${version}`,
		);
		return;
	}

	await uploadJson(latestRelease, "latest.json", {
		version,
		notes: release.body ?? `Release ${tag}`,
		pub_date: new Date().toISOString(),
		platforms,
	});
	console.log(`latest.json updated to ${version} (${Object.keys(platforms)})`);
}

async function currentManifestVersion(
	asset: ForgejoAsset,
): Promise<string | null> {
	try {
		const response = await fetch(asset.browser_download_url, {
			headers: authHeaders,
		});
		if (!response.ok) return null;
		const manifest = (await response.json()) as { version?: string };
		return manifest.version ?? null;
	} catch {
		return null;
	}
}

const command = process.argv[2];
if (command === "publish") {
	await publish();
} else if (command === "latest") {
	await latest();
} else {
	throw new Error("Usage: bun scripts/forgejo-release.ts <publish|latest>");
}
