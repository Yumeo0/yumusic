import { $, file, fileURLToPath, hash, write } from "bun";

/** Build a patched copy while keeping the pinned upstream submodule clean. */
export async function prepareMcp() {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const shell = $.cwd(root);
	const upstream = `${root}/vendor/mcp-server-tauri`;
	const source = `${upstream}/packages/tauri-plugin-mcp-bridge`;
	const relativeDestination = "src-tauri/.cache/tauri-plugin-mcp-bridge";
	const destination = `${root}/${relativeDestination}`;
	const patch = `${root}/patches/tauri-mcp-bridge-tauri3.patch`;
	if (!(await file(`${source}/Cargo.toml`).exists())) {
		throw new Error(
			"Initialize the MCP source with: git submodule update --init vendor/mcp-server-tauri",
		);
	}
	const revision = (
		await shell`git -C ${upstream} rev-parse HEAD`.text()
	).trim();
	const fingerprint = `${revision}:${hash(await file(patch).text())}`;
	const marker = file(`${destination}/.prepared`);
	if ((await marker.exists()) && (await marker.text()) === fingerprint) return;
	await shell`mkdir -p ${`${root}/src-tauri/.cache`}`;
	if (await file(`${destination}/Cargo.toml`).exists()) {
		await shell`mv ${destination} ${`${destination}.previous-${crypto.randomUUID()}`}`;
	}
	await shell`cp -R ${source} ${destination}`;
	await shell`git apply --directory=${relativeDestination} ${patch}`;
	await write(marker, fingerprint);
}

if (import.meta.main) await prepareMcp();
