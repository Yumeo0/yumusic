import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { $, file, fileURLToPath, hash, write } from "bun";

/** Build a patched copy while keeping the pinned upstream submodule clean. */
export async function prepareMcp(
	projectRoot = fileURLToPath(new URL("../", import.meta.url)),
) {
	const root = resolve(projectRoot);
	const shell = $.cwd(root);
	const upstream = join(root, "vendor/mcp-server-tauri");
	const source = join(upstream, "packages/tauri-plugin-mcp-bridge");
	const cache = join(root, "src-tauri/.cache");
	const destination = join(cache, "tauri-plugin-mcp-bridge");
	const patch = join(root, "patches/tauri-mcp-bridge-tauri3.patch");
	if (!(await file(`${source}/Cargo.toml`).exists())) {
		throw new Error(
			"Initialize the MCP source with: git submodule update --init vendor/mcp-server-tauri",
		);
	}
	const revision = (
		await shell`git -C ${upstream} rev-parse HEAD`.text()
	).trim();
	// Git's patch parser requires LF even when autocrlf checks out CRLF.
	const patchText = (await file(patch).text()).replace(/\r\n/g, "\n");
	const fingerprint = `${revision}:${hash(patchText)}`;
	const marker = file(join(destination, ".prepared"));
	if ((await marker.exists()) && (await marker.text()) === fingerprint) return;
	await mkdir(cache, { recursive: true });
	const staging = await mkdtemp(join(cache, "mcp-prepare-"));
	try {
		await cp(source, staging, { recursive: true });
		const stagedPatch = join(staging, ".tauri3.patch");
		await write(stagedPatch, patchText);
		const relativeStaging = `src-tauri/.cache/${basename(staging)}`;
		await shell`git apply --directory=${relativeStaging} ${stagedPatch}`;
		await rm(stagedPatch);
		await write(join(staging, ".prepared"), fingerprint);
		try {
			await rename(
				destination,
				`${destination}.previous-${crypto.randomUUID()}`,
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await rename(staging, destination);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (import.meta.main) await prepareMcp();
