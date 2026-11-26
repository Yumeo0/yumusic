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
	const prepared = async () => {
		try {
			return (await marker.text()) === fingerprint;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	};
	if (await prepared()) return;
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
		if (await prepared()) return;
		const backup = join(cache, `mcp-previous-${crypto.randomUUID()}`);
		let movedOld = false;
		try {
			await rename(destination, backup);
			movedOld = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try {
			await rename(staging, destination);
		} catch (error) {
			if (await prepared()) {
				if (movedOld) await rm(backup, { recursive: true, force: true });
				return;
			}
			if (movedOld) {
				try {
					await rename(backup, destination);
				} catch (restoreError) {
					throw new AggregateError(
						[error, restoreError],
						`Could not install the prepared MCP bridge. The previous copy is at ${backup}.`,
					);
				}
			}
			throw error;
		}
		if (movedOld) await rm(backup, { recursive: true, force: true });
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

if (import.meta.main) await prepareMcp();
