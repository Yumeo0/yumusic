/**
 * Browser shims for the Node built-ins that @mjba/lyrics imports.
 * The package only uses them for optional token caching, which is not
 * possible in a webview — its network requests still work, the token is
 * just kept in memory instead of cached under the user's home directory.
 */
export function join(...parts: string[]): string {
	return parts.filter((p) => p.length > 0).join("/");
}

export function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i <= 0 ? "." : p.slice(0, i);
}

export function homedir(): string {
	return "";
}

export async function readFile(): Promise<string> {
	throw new Error("unavailable in browser");
}

export async function writeFile(): Promise<void> {
	// intentionally discards data — no filesystem in a webview
}

export async function mkdir(): Promise<void> {
	// intentionally discards data — no filesystem in a webview
}

export async function rm(): Promise<void> {
	// intentionally discards data — no filesystem in a webview
}

export default { join, dirname, homedir, readFile, writeFile, mkdir, rm };
