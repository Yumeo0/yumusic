import { file, write } from "bun";

const ROOT = new URL("../", import.meta.url);

const versionFiles = {
	"package.json": null,
	"src-tauri/tauri.conf.json": null,
	"src-tauri/Cargo.toml": /^(version = ")[^"]+(?=")/m,
	"src-tauri/Cargo.lock":
		/(\[\[package\]\]\r?\nname = "app"\r?\nversion = ")[^"]+(?=")/,
};
export async function prepareVersionFiles(version: string, root = ROOT) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))
		throw new Error(`Invalid release version: ${version}`);

	return Promise.all(
		Object.entries(versionFiles).map(async ([name, pattern]) => {
			const path = new URL(name, root);
			const source = file(path);
			if (!pattern) {
				const json = await source.json();
				if (typeof json.version !== "string")
					throw new Error(`Missing version in ${name}`);
				return {
					path,
					contents: `${JSON.stringify({ ...json, version }, null, "\t")}\n`,
				};
			}
			const text = await source.text();
			if (!pattern.test(text))
				throw new Error(`Missing app version in ${name}`);
			return {
				path,
				contents: text.replace(
					pattern,
					(_, prefix: string) => prefix + version,
				),
			};
		}),
	);
}

if (import.meta.main) {
	const version = process.argv[2];
	if (!version) throw new Error("Usage: bun scripts/stamp-version.ts VERSION");
	for (const { path, contents } of await prepareVersionFiles(version))
		await write(path, contents);
}
