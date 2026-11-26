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
	expect((await service.getPlaybackProof("video-b")).token).toBe(
		"native-video-b",
	);
	expect(bindings).toEqual(["video-a", "video-b"]);
});

test("attestation failure is surfaced instead of returning a cold-start token", async () => {
	const service = new BotguardService(async () => {
		throw new Error("minter unavailable");
	});
	await expect(service.getPlaybackProof("video-a")).rejects.toThrow(
		"minter unavailable",
	);
	expect(service.playbackCookie).toBeUndefined();
});

test("incomplete native proofs are rejected", async () => {
	const service = new BotguardService(async (binding) => ({
		...proof(binding),
		token: "",
	}));
	await expect(service.getPlaybackProof("video-a")).rejects.toThrow(
		"ready playback attestation",
	);
});

test("playback goes ahead of waiting download mints and cancelled work is skipped", async () => {
	const firstMint = Promise.withResolvers<PlaybackProof>();
	const bindings: string[] = [];
	const service = new BotguardService(async (binding) => {
		bindings.push(binding);
		return binding === "active-download" ? firstMint.promise : proof(binding);
	});
	const controller = new AbortController();
	const active = service.getPlaybackProof("active-download", undefined, true);
	const waiting = service.getPlaybackProof("waiting-download", undefined, true);
	const cancelled = service
		.getPlaybackProof("cancelled-download", controller.signal, true)
		.catch((error: unknown) => error);
	const playback = service.getPlaybackProof("playing-song");
	controller.abort();
	expect(await cancelled).toBe(controller.signal.reason);
	firstMint.resolve(proof("active-download"));
	await Promise.all([active, waiting, playback]);
	expect(bindings).toEqual([
		"active-download",
		"playing-song",
		"waiting-download",
	]);
});
