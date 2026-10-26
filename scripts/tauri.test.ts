import { expect, test } from "bun:test";
import { tauriArgs } from "./tauri";

const bridgeConfig = ["--config", '{"app":{"withGlobalTauri":true}}'];

test("desktop dev enables the MCP bridge before runner arguments", () => {
	expect(tauriArgs(["dev", "--", "--locked"])).toEqual([
		"dev",
		"--features",
		"mcp-bridge",
		...bridgeConfig,
		"--",
		"--locked",
	]);
});

test("desktop dev preserves requested features", () => {
	expect(tauriArgs(["dev", "--features", "other"])).toEqual([
		"dev",
		"--features",
		"mcp-bridge",
		"other",
		...bridgeConfig,
	]);
	expect(tauriArgs(["dev", "--features=other"])).toEqual([
		"dev",
		"--features=other,mcp-bridge",
		...bridgeConfig,
	]);
});

test("production, mobile, and runner features are handled separately", () => {
	for (const args of [["build"], ["android", "dev"], ["ios", "dev"]]) {
		expect(tauriArgs(args)).toEqual(args);
	}
	expect(tauriArgs(["dev", "--", "--features", "runner"])).toEqual([
		"dev",
		"--features",
		"mcp-bridge",
		...bridgeConfig,
		"--",
		"--features",
		"runner",
	]);
});
