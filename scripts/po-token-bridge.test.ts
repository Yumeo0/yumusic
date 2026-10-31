import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { file } from "bun";

const source = await file(
	new URL("../src-tauri/src/po_token_bridge.js", import.meta.url),
).text();

test("native bridge awaits readiness and mints each video's token separately", async () => {
	let ready = false;
	const bindings: unknown[] = [];
	const results: unknown[] = [];
	let resolveResult: () => void = () => undefined;
	const nextResult = () =>
		new Promise<void>((resolve) => {
			resolveResult = resolve;
		});
	const native = {
		f: async () => {
			await Promise.resolve();
			ready = true;
		},
		mws: async (options: unknown) => {
			expect(ready).toBe(true);
			bindings.push(options);
			return "ready-token";
		},
	};
	const window = {
		crossOriginFrame: {
			get bevasrs(): never {
				throw new Error("Cross-origin frame");
			},
		},
		minterBridge: { bevasrs: { wpc: async () => native } },
		ytcfg: {
			get: (key: string) =>
				key === "INNERTUBE_CONTEXT"
					? { client: { visitorData: "visitor" } }
					: 0,
		},
		location: {
			set href(url: string) {
				results.push(
					JSON.parse(new URL(url).searchParams.get("payload") ?? "null"),
				);
				resolveResult();
			},
		},
		__yumusicMintPoToken: (_id: string, _binding: string) => undefined,
	};
	runInNewContext(source, {
		window,
		navigator: { userAgent: "native-agent" },
		setTimeout,
	});
	for (const [id, binding] of [
		["1", "video-a"],
		["2", "video-b"],
	]) {
		const done = nextResult();
		window.__yumusicMintPoToken(id, binding);
		window.__yumusicMintPoToken(id, binding);
		await done;
	}
	expect(bindings).toEqual([
		{ c: "video-a", mc: false, me: false },
		{ c: "video-b", mc: false, me: false },
	]);
	expect(results).toHaveLength(2);
	expect(results[0]).toMatchObject({
		token: "ready-token",
		context: { client: { visitorData: "visitor", userAgent: "native-agent" } },
	});
});

test("native readiness failures are reported without a fallback token", async () => {
	const result = Promise.withResolvers<Record<string, unknown>>();
	const window = {
		minterBridge: {
			bevasrs: {
				wpc: async () => ({
					f: async () => {
						throw new Error("attestation rejected");
					},
				}),
			},
		},
		location: {
			set href(url: string) {
				result.resolve(
					JSON.parse(new URL(url).searchParams.get("payload") ?? "null"),
				);
			},
		},
		__yumusicMintPoToken: (_id: string, _binding: string) => undefined,
	};
	runInNewContext(source, { window, setTimeout });
	window.__yumusicMintPoToken("failure", "video-a");
	const response = await result.promise;
	expect(response.error).toBeDefined();
	expect(response.token).toBeUndefined();
});
