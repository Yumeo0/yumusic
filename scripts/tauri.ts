import { fileURLToPath, spawn } from "bun";
import { prepareMcp } from "./prepare-mcp";

/** Enable the bridge for desktop dev without adding it to production builds. */
export function tauriArgs(input: string[]): string[] {
	const args = [...input];
	if (args[0] !== "dev") return args;
	const separator = args.indexOf("--");
	const featureIndex = args.findIndex(
		(arg, index) =>
			(separator < 0 || index < separator) &&
			(arg === "--features" || arg === "-f" || arg.startsWith("--features=")),
	);
	if (featureIndex < 0) {
		args.splice(1, 0, "--features", "mcp-bridge");
	} else if (args[featureIndex].startsWith("--features=")) {
		args[featureIndex] += ",mcp-bridge";
	} else {
		args.splice(featureIndex + 1, 0, "mcp-bridge");
	}
	const runnerIndex = args.indexOf("--");
	args.splice(
		runnerIndex < 0 ? args.length : runnerIndex,
		0,
		"--config",
		'{"app":{"withGlobalTauri":true}}',
	);
	return args;
}

if (import.meta.main) {
	await prepareMcp();
	const root = fileURLToPath(new URL("../", import.meta.url));
	const child = spawn(
		[
			process.execPath,
			fileURLToPath(
				new URL("../node_modules/@tauri-apps/cli/tauri.js", import.meta.url),
			),
			...tauriArgs(process.argv.slice(2)),
		],
		{ cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
	process.exit(await child.exited);
}
