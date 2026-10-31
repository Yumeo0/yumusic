import { expect, test } from "bun:test";
import type { AudioStreamSession } from "./media-buffer";
import {
	NATIVE_AUDIO_EVENT,
	NativeAudioElement,
	type NativeAudioEvent,
} from "./native-audio";

const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fixture() {
	const events = new EventTarget();
	const commands: Record<string, unknown>[] = [];
	const batches: { id: string; epoch: number; data: string }[] = [];
	const media = new NativeAudioElement(0, {
		events,
		command: async (command) => {
			commands.push(command);
		},
		append: async (batch) => {
			batches.push(batch);
			return true;
		},
	});
	const emit = (state: NativeAudioEvent) =>
		events.dispatchEvent(
			new CustomEvent(NATIVE_AUDIO_EVENT, {
				detail: {
					deck: 0,
					id: commands.findLast((c) => c.op === "load")?.id,
					...state,
				},
			}),
		);
	return { media, commands, batches, emit };
}

test("a native decoder failure before readiness clears playback intent", async () => {
	const f = fixture();
	let pauses = 0;
	f.media.addEventListener("pause", () => pauses++);
	const controller = new AbortController();
	const mounted = f.media.mountStream(
		() => ({
			audio: new ReadableStream<Uint8Array>(),
			mime: "audio/mp4",
			dispose: () => undefined,
		}),
		{ duration: 100, signal: controller.signal, onReady: () => undefined },
	);
	await flush();
	f.emit({ type: "error", message: "Unsupported audio" });
	await expect(mounted).rejects.toThrow("Unsupported audio");
	expect(pauses).toBe(1);
	expect(f.media.paused).toBe(true);
	f.emit({ type: "state", ready: true, paused: false });
	expect(f.media.paused).toBe(true);
	f.media.dispose();
});

test("native seeks replace the SABR producer and late track events cannot alter the new clock", async () => {
	const f = fixture();
	const sessions: {
		start: number;
		stopped: number;
		controller: ReadableStreamDefaultController<Uint8Array>;
	}[] = [];
	const create = (start: number): AudioStreamSession => {
		const session = {
			start,
			stopped: 0,
			controller:
				null as unknown as ReadableStreamDefaultController<Uint8Array>,
		};
		const audio = new ReadableStream<Uint8Array>({
			start: (controller) => {
				session.controller = controller;
			},
		});
		sessions.push(session);
		return {
			audio,
			mime: "audio/mp4",
			dispose: () => {
				session.stopped++;
			},
		};
	};
	let ready = 0;
	let ended = 0;
	f.media.addEventListener("ended", () => ended++);
	const controller = new AbortController();
	const mounted = f.media.mountStream(create, {
		duration: 120,
		signal: controller.signal,
		onReady: () => ready++,
	});
	await flush();
	const id = String(f.commands[0].id);
	f.emit({ type: "stream", epoch: 1, position: 0 });
	sessions[0].controller.enqueue(new Uint8Array([1, 2, 3]));
	await flush();
	f.emit({
		type: "state",
		ready: true,
		position: 0,
		paused: true,
		duration: 120,
	});
	expect(ready).toBe(1);
	f.media.currentTime = 30;
	expect(f.media.seeking).toBe(true);
	f.emit({ type: "stream", epoch: 2, position: 30 });
	await flush();
	expect(sessions[0].stopped).toBeGreaterThan(0);
	expect(sessions[1].start).toBe(30_000);
	sessions[1].controller.enqueue(new Uint8Array([4, 5]));
	await flush();
	expect(f.batches.map((b) => [b.epoch, atob(b.data)])).toEqual([
		[1, "\x01\x02\x03"],
		[2, "\x04\x05"],
	]);
	f.emit({ type: "state", ready: true, position: 30, paused: true });
	expect(f.media.seeking).toBe(false);
	expect(f.media.currentTime).toBe(30);
	controller.abort();
	await mounted;
	f.media.src = "";
	f.media.load();
	f.emit({ type: "state", id, ended: true, position: 120 });
	expect(ended).toBe(0);
	expect(f.media.readyState).toBe(0);
	f.media.dispose();
});

test("native batches are bounded and cancellation releases a backpressured producer", async () => {
	const events = new EventTarget();
	let id = "";
	let disposed = 0;
	const sizes: number[] = [];
	const media = new NativeAudioElement(1, {
		events,
		command: async (command) => {
			if (command.op === "load") id = String(command.id);
		},
		append: async (batch) => {
			sizes.push(atob(batch.data).length);
			return false;
		},
	});
	const controller = new AbortController();
	const mounted = media.mountStream(
		() => ({
			mime: "audio/webm",
			audio: new ReadableStream({
				start: (output) => output.enqueue(new Uint8Array(200_000)),
			}),
			dispose: () => disposed++,
		}),
		{ duration: 100, signal: controller.signal, onReady: () => undefined },
	);
	await flush();
	events.dispatchEvent(
		new CustomEvent(NATIVE_AUDIO_EVENT, {
			detail: { type: "stream", deck: 1, id, epoch: 1, position: 0 },
		}),
	);
	await flush();
	expect(sizes).toEqual([65536]);
	controller.abort();
	await mounted;
	await flush();
	expect(disposed).toBeGreaterThan(0);
	media.dispose();
});
