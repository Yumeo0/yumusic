import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	$,
	file,
	fileURLToPath,
	Glob,
	JSONC,
	version as runningBunVersion,
	TOML,
	write,
} from "bun";

// Generation runs online. Every resulting download is pinned before sandboxed builds.
const root = fileURLToPath(new URL("../", import.meta.url));
const shell = $.cwd(root);
const release = process.argv[2] === "--release";
const pkg = await file(`${root}/package.json`).json();
const bunVersion = pkg.packageManager.replace(/^bun@/, "");
if (runningBunVersion !== bunVersion) {
	throw new Error(
		`Generate with Bun ${bunVersion}; cache layouts are version-specific`,
	);
}
const lock = JSONC.parse(await file(`${root}/bun.lock`).text()) as {
	packages: Record<
		string,
		[
			string,
			string,
			{ os?: string | string[]; cpu?: string | string[] },
			string,
		]
	>;
};
const cargoLock = TOML.parse(
	await file(`${root}/src-tauri/Cargo.lock`).text(),
) as {
	package: {
		name: string;
		version: string;
		source?: string;
		checksum?: string;
	}[];
};
const sourceInputs = ["package.json", "bun.lock", "src-tauri/Cargo.lock"];
const sourceOutputs = [
	"flatpak/bun-sources.json",
	"flatpak/cargo-sources.json",
	"flatpak/bun-toolchain-sources.json",
	"flatpak/application.patch",
];
const digest = async (path: string) =>
	createHash("sha256")
		.update(Buffer.from(await file(`${root}/${path}`).arrayBuffer()))
		.digest("hex");
const applicationPatch = async (base: string) =>
	shell`git diff --binary ${base} -- package.json bun.lock patches scripts/flatpak.ts scripts/prepare-mcp.ts src-tauri src`.text();
// A release downloads this published revision, never an older development snapshot.
if (release) {
	const changes = await applicationPatch("HEAD");
	if (changes.trim())
		throw new Error("Flatpak releases require committed application sources");
	const tag = process.env.RELEASE_TAG;
	if (!tag || tag !== `v${pkg.version}`)
		throw new Error("RELEASE_TAG must match the package.json version");
	const head = (await shell`git rev-parse HEAD`.text()).trim();
	const tagged = (
		await shell`git rev-parse ${`${tag}^{commit}`}`.text()
	).trim();
	if (head !== tagged)
		throw new Error("Flatpak releases must check out RELEASE_TAG");
}
async function snapshot(base: string) {
	await write(
		`${root}/flatpak/application.patch`,
		await applicationPatch(base),
	);
	const manifest = await file(`${root}/dev.yumeo.yumusic.json`).json();
	manifest.modules[0].sources[0].commit = base;
	await write(
		`${root}/dev.yumeo.yumusic.json`,
		`${JSON.stringify(manifest, null, 4)}\n`,
	);
	await write(
		`${root}/flatpak/source-locks.json`,
		`${JSON.stringify(
			{
				bun: bunVersion,
				base,
				inputs: Object.fromEntries(
					await Promise.all(
						sourceInputs.map(async (path) => [path, await digest(path)]),
					),
				),
				outputs: Object.fromEntries(
					await Promise.all(
						sourceOutputs.map(async (path) => [path, await digest(path)]),
					),
				),
			},
			null,
			4,
		)}\n`,
	);
}
if (process.argv[2] === "--check") {
	const saved = await file(`${root}/flatpak/source-locks.json`).json();
	for (const [path, expected] of Object.entries({
		...saved.inputs,
		...saved.outputs,
	})) {
		if ((await digest(path)) !== expected)
			throw new Error(`Stale Flatpak source: ${path}; regenerate sources`);
	}
	if (
		(await applicationPatch(saved.base)) !==
		(await file(`${root}/flatpak/application.patch`).text())
	)
		throw new Error("Stale application patch; regenerate the snapshot");
	const manifest = await file(`${root}/dev.yumeo.yumusic.json`).json();
	if (manifest.modules[0].sources[0].commit !== saved.base)
		throw new Error(
			"Manifest source revision disagrees with source-locks.json",
		);
	console.log(
		"Flatpak dependency sources and application snapshot match the working tree",
	);
	process.exit(0);
}
if (process.argv[2] === "--snapshot") {
	await snapshot((await file(`${root}/flatpak/source-locks.json`).json()).base);
	process.exit(0);
}
const scratch = await mkdtemp(join(tmpdir(), "yumusic-flatpak-sources-"));
try {
	await cp(`${root}/package.json`, `${scratch}/package.json`);
	await cp(`${root}/bun.lock`, `${scratch}/bun.lock`);
	await cp(`${root}/patches`, `${scratch}/patches`, { recursive: true });
	await $`bun install --cwd ${scratch} --frozen-lockfile --ignore-scripts --os linux --cpu '*' --cache-dir ${scratch}/cache`;
	const caches = new Map<string, string>();
	for (const path of [
		...new Glob("*/package.json").scanSync(`${scratch}/cache`),
		...new Glob("@*/*/package.json").scanSync(`${scratch}/cache`),
	]) {
		const metadata = await file(`${scratch}/cache/${path}`).json();
		const directory = path.slice(0, -"/package.json".length);
		// Ignore Bun's version index and patched variants; it applies patches on install.
		if (directory.includes("@@@1") && !directory.includes("_patch_hash=")) {
			caches.set(`${metadata.name}@${metadata.version}`, directory);
		}
	}
	const bunSources = [];
	for (const entry of Object.values(lock.packages)) {
		const [resolved, registry, platform, integrity] = entry;
		const matches = (value: string | string[] | undefined, allowed: string[]) =>
			!value ||
			(Array.isArray(value) ? value : [value]).some((v) => allowed.includes(v));
		if (
			!matches(platform.os, ["linux"]) ||
			!matches(platform.cpu, ["x64", "arm64"])
		)
			continue;
		if (registry !== "" || !integrity?.startsWith("sha512-"))
			throw new Error(`Unsupported npm source: ${resolved}`);
		const split = resolved.lastIndexOf("@");
		const name = resolved.slice(0, split);
		const version = resolved.slice(split + 1);
		// Lockfiles also contain unreachable optional subtrees, which Bun does not warm.
		const cache =
			caches.get(resolved) ??
			(/^\d+\.\d+\.\d+$/.test(version) ? `${resolved}@@@1` : undefined);
		if (!cache) throw new Error(`Bun did not cache ${resolved}`);
		const architectures = platform.cpu
			? (Array.isArray(platform.cpu) ? platform.cpu : [platform.cpu])
					.map((cpu) => ({ x64: "x86_64", arm64: "aarch64" })[cpu])
					.filter(Boolean)
			: undefined;
		bunSources.push({
			type: "archive",
			"archive-type": "tar-gzip",
			url: `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
			sha512: Buffer.from(integrity.slice(7), "base64").toString("hex"),
			dest: `bun-cache/${cache}`,
			...(architectures ? { "only-arches": architectures } : {}),
		});
	}
	await write(
		`${root}/flatpak/bun-sources.json`,
		`${JSON.stringify(bunSources, null, 4)}\n`,
	);
	const cargoSources = [];
	for (const dependency of cargoLock.package) {
		if (!dependency.source) continue;
		if (
			dependency.source !==
				"registry+https://github.com/rust-lang/crates.io-index" ||
			!dependency.checksum
		) {
			throw new Error(`Unsupported Cargo source: ${dependency.name}`);
		}
		const { name, version, checksum } = dependency;
		const dest = `cargo/vendor/${name}-${version}`;
		cargoSources.push({
			type: "archive",
			"archive-type": "tar-gzip",
			url: `https://static.crates.io/crates/${name}/${name}-${version}.crate`,
			sha256: checksum,
			dest,
		});
		cargoSources.push({
			type: "inline",
			contents: JSON.stringify({ package: checksum, files: {} }),
			dest,
			"dest-filename": ".cargo-checksum.json",
		});
	}
	cargoSources.push({
		type: "inline",
		contents:
			'[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "cargo/vendor"\n[net]\noffline = true\n',
		dest: ".cargo",
		"dest-filename": "config.toml",
	});
	await write(
		`${root}/flatpak/cargo-sources.json`,
		`${JSON.stringify(cargoSources, null, 4)}\n`,
	);
	const tools = [];
	for (const [arch, asset] of [
		["x86_64", "x64"],
		["aarch64", "aarch64"],
	]) {
		const url = `https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-${asset}.zip`;
		const response = await fetch(url);
		if (!response.ok)
			throw new Error(`Download failed: ${url}: ${response.status}`);
		const sha256 = createHash("sha256")
			.update(Buffer.from(await response.arrayBuffer()))
			.digest("hex");
		tools.push({
			type: "archive",
			"archive-type": "zip",
			url,
			sha256,
			dest: "bun",
			"only-arches": [arch],
		});
	}
	await write(
		`${root}/flatpak/bun-toolchain-sources.json`,
		`${JSON.stringify(tools, null, 4)}\n`,
	);
	// Until the packaging prerequisites are released, build a pinned commit plus an explicit patch.
	await snapshot((await shell`git rev-parse HEAD`.text()).trim());
	if (release) {
		const manifest = await file(`${root}/dev.yumeo.yumusic.json`).json();
		// The tagged source already includes all application changes. An empty
		// development patch would fail flatpak-builder's patch extraction step.
		manifest.modules[0].sources = manifest.modules[0].sources.filter(
			(source: { type?: string; path?: string } | string) =>
				typeof source === "string" ||
				source.type !== "patch" ||
				source.path !== "flatpak/application.patch",
		);
		await write(
			`${root}/flatpak-release.json`,
			`${JSON.stringify(manifest, null, 4)}\n`,
		);
	}
	console.log(
		`Generated ${bunSources.length} npm archives, ${cargoLock.package.filter((p) => p.source).length} Cargo archives, and Bun for both architectures.`,
	);
} finally {
	await rm(scratch, { recursive: true, force: true });
}
