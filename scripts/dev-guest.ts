import { tmpdir } from "node:os";
import { join } from "node:path";
import { file, fileURLToPath, spawn } from "bun";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = await file(join(root, "src-tauri/tauri.conf.json")).json();
const config = {
	identifier: "dev.yumeo.yumusic.guest",
	build: {
		devUrl: "http://localhost:5174",
		beforeDevCommand: "bun run dev --port 5174",
	},
	app: {
		// Preserve the main window's WebView2 settings and login compatibility.
		windows: base.app.windows.map((window: { title?: string }) => ({
			...window,
			title: "YuMusic · Guest",
		})),
	},
};

const child = spawn(
	[
		process.execPath,
		join(root, "scripts/tauri.ts"),
		"dev",
		"--config",
		JSON.stringify(config),
		...process.argv.slice(2),
	],
	{
		cwd: root,
		env: {
			...process.env,
			// Avoid locking the first instance's executable or triggering its watcher.
			CARGO_TARGET_DIR: join(tmpdir(), "yumusic-guest-target"),
		},
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);
process.exit(await child.exited);
