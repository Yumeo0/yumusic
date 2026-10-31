import { expect, test } from "bun:test";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, spawn, write } from "bun";

for (const concurrentCreation of [false, true]) {
	test(`publishes a standalone Flatpak${concurrentCreation ? " when another job creates the release" : " to an existing release"}`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "yumusic-flatpak-publish-"));
		const name = "YuMusic_0.6.0_x86_64.flatpak";
		const path = join(directory, name);
		await write(path, "flatpak fixture");
		const requests: string[] = [];
		let created = !concurrentCreation;
		let uploaded: { name: string; contents: string } | undefined;
		const server = serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				requests.push(`${request.method} ${url.pathname}`);
				if (url.pathname.endsWith("/releases/tags/v0.6.0")) {
					return Response.json(
						created ? { id: 42, tag_name: "v0.6.0", assets: [] } : {},
						{ status: created ? 200 : 404 },
					);
				}
				if (request.method === "POST" && url.pathname.endsWith("/releases")) {
					created = true;
					return Response.json(
						{ message: "Release already exists" },
						{ status: 409 },
					);
				}
				if (
					request.method === "POST" &&
					url.pathname.endsWith("/releases/42/assets")
				) {
					const attachment = (await request.formData()).get(
						"attachment",
					) as File;
					uploaded = {
						name: attachment.name,
						contents: await attachment.text(),
					};
					return Response.json({ id: 7, name: attachment.name });
				}
				return new Response("Unexpected request", { status: 500 });
			},
		});
		try {
			const child = spawn(
				[process.execPath, "scripts/forgejo-release.ts", "publish-flatpak"],
				{
					env: {
						...process.env,
						FORGEJO_URL: server.url.origin,
						FORGEJO_REPOSITORY: "test/YuMusic",
						FORGEJO_TOKEN: "fixture",
						RELEASE_TAG: "v0.6.0",
						RELEASE_VERSION: "0.6.0",
						RELEASE_NOTES: "Reviewed fixture notes",
						BUNDLE_DIR: directory,
						FLATPAK_ARCH: "x86_64",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const error = await new Response(child.stderr).text();
			expect(await child.exited, error).toBe(0);
			expect(uploaded).toEqual({ name, contents: "flatpak fixture" });
			expect(
				requests.filter((request) => request.includes("/assets")),
			).toHaveLength(1);
		} finally {
			server.stop(true);
			await unlink(path);
			await rmdir(directory);
		}
	});
}

test("a missing Flatpak fails before creating or changing a release", async () => {
	let requests = 0;
	const server = serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return new Response("Unexpected request", { status: 500 });
		},
	});
	try {
		const child = spawn(
			[process.execPath, "scripts/forgejo-release.ts", "publish-flatpak"],
			{
				env: {
					...process.env,
					FORGEJO_URL: server.url.origin,
					FORGEJO_REPOSITORY: "test/YuMusic",
					FORGEJO_TOKEN: "fixture",
					RELEASE_TAG: "v0.6.0",
					RELEASE_VERSION: "0.6.0",
					BUNDLE_DIR: `nonexistent-${crypto.randomUUID()}`,
					FLATPAK_ARCH: "x86_64",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await child.exited).not.toBe(0);
		expect(await new Response(child.stderr).text()).toContain(
			"Flatpak bundle not found",
		);
		expect(requests).toBe(0);
	} finally {
		server.stop(true);
	}
});
