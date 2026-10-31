import { expect, test } from "bun:test";
import type { Innertube } from "youtubei.js/web";
import { BotguardService, type PlaybackProof } from "./botguard-service";

const proof = (binding: string): PlaybackProof => ({
	token: `native-${binding}`,
	context: {
		client: { visitorData: "native-visitor", userAgent: "native-agent" },
	} as PlaybackProof["context"],
	accountIndex: 0,
	cookie: "VISITOR_INFO1_LIVE=native-visitor",
});

test("player attestation is video-bound and uses the minter's visitor context", async () => {
	const bindings: string[] = [];
	const service = new BotguardService(async (binding) => {
		bindings.push(binding);
		return proof(binding);
	});
	const client = {
		session: { context: { client: { visitorData: "unrelated" } } },
	} as Innertube;
	expect(await service.preparePlayback(client, "video-a")).toBe(
		"native-video-a",
	);
	expect(bindings).toEqual(["video-a"]);
	expect(client.session.context.client.visitorData).toBe("native-visitor");
	expect(client.session.context.client.userAgent).toBe("native-agent");
	expect(service.playbackCookie).toBe("VISITOR_INFO1_LIVE=native-visitor");
	expect(service.playbackUserAgent).toBe("native-agent");
	expect(await service.mintToken("video-b")).toBe("native-video-b");
	expect(bindings).toEqual(["video-a", "video-b"]);
});

test("attestation failure is surfaced instead of returning a cold-start token", async () => {
	const service = new BotguardService(async () => {
		throw new Error("minter unavailable");
	});
	await expect(service.mintToken("video-a")).rejects.toThrow(
		"minter unavailable",
	);
	expect(service.playbackCookie).toBeUndefined();
});

test("incomplete native proofs are rejected", async () => {
	const service = new BotguardService(async (binding) => ({
		...proof(binding),
		token: "",
	}));
	await expect(service.mintToken("video-a")).rejects.toThrow(
		"ready playback attestation",
	);
});
