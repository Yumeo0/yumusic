import { afterEach, beforeEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $, file, write } from "bun";
import { prepareMcp } from "./prepare-mcp";

let root: string;
let source: string;
let destination: string;
let patch: string;
const manifestText = async (directory: string) =>
	(await file(join(directory, "Cargo.toml")).text()).replace(/\r\n/g, "\n");
const patchText = [
	"diff --git a/Cargo.toml b/Cargo.toml",
	"--- a/Cargo.toml",
	"+++ b/Cargo.toml",
	"@@ -1 +1 @@",
	'-tauri = "2"',
	'+tauri = "3"',
	"",
].join("\r\n");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "yumusic mcp test-"));
	source = join(
		root,
		"vendor/mcp-server-tauri/packages/tauri-plugin-mcp-bridge",
	);
	destination = join(root, "src-tauri/.cache/tauri-plugin-mcp-bridge");
	patch = join(root, "patches/tauri-mcp-bridge-tauri3.patch");
	await mkdir(source, { recursive: true });
	await write(join(source, "Cargo.toml"), 'tauri = "2"\n');
	await write(patch, patchText);
	const shell = $.cwd(root);
	await shell`git init`.quiet();
	await shell`git add vendor patches`.quiet();
	await shell`git -c user.name=Test -c user.email=test@example.com commit -m fixture`.quiet();
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

test("prepares CRLF patches in paths with spaces and reuses the prepared copy", async () => {
	await prepareMcp(root);
	expect(await manifestText(destination)).toBe('tauri = "3"\n');
	expect(await manifestText(source)).toBe('tauri = "2"\n');
	const entries = await readdir(join(root, "src-tauri/.cache"));
	await prepareMcp(root);
	expect(await readdir(join(root, "src-tauri/.cache"))).toEqual(entries);
});

test("replaces an existing unprepared copy using native file operations", async () => {
	await cp(source, destination, { recursive: true });
	await prepareMcp(root);
	expect(await manifestText(destination)).toBe('tauri = "3"\n');
	const entries = await readdir(join(root, "src-tauri/.cache"));
	const previous = entries.find((entry) =>
		entry.startsWith("tauri-plugin-mcp-bridge.previous-"),
	);
	expect(previous).toBeDefined();
	expect(
		await manifestText(join(root, "src-tauri/.cache", previous ?? "")),
	).toBe('tauri = "2"\n');
});

test("keeps the prepared copy intact when an updated patch fails", async () => {
	await prepareMcp(root);
	const marker = await file(join(destination, ".prepared")).text();
	await write(patch, patchText.replace('-tauri = "2"', '-tauri = "missing"'));
	await expect(prepareMcp(root)).rejects.toThrow();
	expect(await file(join(destination, ".prepared")).text()).toBe(marker);
	expect(await manifestText(destination)).toBe('tauri = "3"\n');
	expect(await readdir(join(root, "src-tauri/.cache"))).toEqual([
		"tauri-plugin-mcp-bridge",
	]);
});
