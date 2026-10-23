import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { SabrStream } from "googlevideo/sabr-stream";

test("SABR pauses its network timeout while the player applies backpressure", async () => {
	const stream = new SabrStream({
		videoId: "test",
		serverAbrStreamingUrl: "https://example.com/videoplayback",
		videoPlaybackUstreamerConfig: "",
		clientInfo: {},
		formats: [],
		audioHighWaterMark: 1,
	});
	// Use a short request clock; exercise the real stream's drain notification.
	const runtime = stream as unknown as {
		abortController: AbortController;
		requestTimeoutId: ReturnType<typeof setTimeout> | undefined;
		resetRequestTimeout: () => void;
		clearRequestTimeout: () => void;
		waitForDrain: () => Promise<void>;
		trackCollection: {
			audio: {
				output: {
					stream: ReadableStream<Uint8Array>;
					controller: ReadableStreamDefaultController<Uint8Array>;
				};
			};
		};
	};
	runtime.abortController = new AbortController();
	runtime.resetRequestTimeout = () => {
		runtime.clearRequestTimeout();
		runtime.requestTimeoutId = setTimeout(
			() => runtime.abortController.abort(),
			10,
		);
	};
	const reader = runtime.trackCollection.audio.output.stream.getReader();
	try {
		runtime.trackCollection.audio.output.controller.enqueue(new Uint8Array(2));
		runtime.resetRequestTimeout();
		const draining = runtime.waitForDrain();
		await delay(25);
		expect(runtime.abortController.signal.aborted).toBe(false);
		await reader.read();
		await draining;
		expect(runtime.requestTimeoutId).toBeDefined();
	} finally {
		runtime.clearRequestTimeout();
		await reader.cancel();
		reader.releaseLock();
	}
});
