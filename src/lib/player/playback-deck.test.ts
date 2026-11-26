import { expect, test } from "bun:test";
import { NATIVE_AUDIO_EVENT, NativeAudioElement } from "./native-audio";
import { PlaybackDeck } from "./playback-deck";

const prepare = { autoPlay: false, volume: () => 0.5 };
const local = { kind: "file", path: "download.m4a", duration: 80 } as const;

function nativeDeck() {
	const events = new EventTarget();
	const commands: Record<string, unknown>[] = [];
	const media = new NativeAudioElement(0, {
		events,
		command: async (command) => {
			commands.push(command);
		},
		append: async () => true,
	});
	const deck = new PlaybackDeck({ current: media });
	const ready = (id: unknown) =>
		events.dispatchEvent(
			new CustomEvent(NATIVE_AUDIO_EVENT, {
				detail: { type: "state", deck: 0, id, ready: true, paused: true },
			}),
		);
	const fail = (id: unknown, message: string) =>
		events.dispatchEvent(
			new CustomEvent(NATIVE_AUDIO_EVENT, {
				detail: { type: "error", deck: 0, id, message },
			}),
		);
	return { deck, media, commands, ready, fail };
}

test("preparation waits for native playable data and leaves the deck paused", async () => {
	const { deck, media, commands, ready } = nativeDeck();
	try {
		const preparing = deck.mount(local, prepare);
		await Promise.resolve();
		expect(deck.ready).toBe(false);
		ready(commands.find((command) => command.op === "load")?.id);
		await preparing;
		expect(deck.ready).toBe(true);
		expect(media.paused).toBe(true);
	} finally {
		deck.reset();
		media.dispose();
	}
});

test("playing a prepared native deck uses the existing media id without reloading", async () => {
	const { deck, media, commands, ready } = nativeDeck();
	try {
		const preparing = deck.mount(local, prepare);
		const id = commands.find((command) => command.op === "load")?.id;
		ready(id);
		await preparing;
		expect(await deck.play()).toBe(true);
		expect(commands.filter((command) => command.op === "load")).toHaveLength(1);
		expect(commands.at(-1)).toMatchObject({ op: "play", id });
	} finally {
		deck.reset();
		media.dispose();
	}
});

test("readiness from a superseded file cannot complete or reset its replacement", async () => {
	const { deck, media, commands, ready } = nativeDeck();
	try {
		const first = deck.mount(local, prepare);
		const replacement = deck.mount(
			{ ...local, path: "replacement.m4a" },
			prepare,
		);
		const [previous, current] = commands.filter(
			(command) => command.op === "load",
		);
		ready(previous.id);
		await expect(first).rejects.toHaveProperty("name", "AbortError");
		expect(deck.ready).toBe(false);
		expect(media.src).toBe(`native:${current.id}`);
		ready(current.id);
		await replacement;
		expect(deck.ready).toBe(true);
	} finally {
		deck.reset();
		media.dispose();
	}
});

test("browser autoplay denial leaves a downloaded track ready for manual resume", async () => {
	let hasGesture = false;
	const media = Object.assign(new EventTarget(), {
		src: "",
		readyState: 0,
		error: null,
		paused: true,
		volume: 1,
		pause() {
			this.paused = true;
		},
		load() {
			this.readyState = 0;
		},
		removeAttribute() {
			this.src = "";
		},
		async play() {
			if (!hasGesture)
				throw new DOMException("Interaction required", "NotAllowedError");
			this.paused = false;
		},
	});
	const deck = new PlaybackDeck({
		current: media as unknown as HTMLVideoElement,
	});
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			__TAURI_INTERNALS__: { convertFileSrc: () => "asset://download.m4a" },
		},
	});
	let mounting: Promise<void>;
	try {
		mounting = deck.mount(local, { ...prepare, autoPlay: true });
	} finally {
		if (originalWindow)
			Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
	media.readyState = 4;
	media.dispatchEvent(new Event("canplay"));
	await mounting;
	expect(deck.ready).toBe(true);
	expect(media.paused).toBe(true);
	expect(media.src).toBe("asset://download.m4a");
	hasGesture = true;
	await media.play();
	expect(media.paused).toBe(false);
	deck.reset();
});

test("a streamed track can be mounted again after a late decoder failure", async () => {
	const { deck, media, commands, ready, fail } = nativeDeck();
	const failure = Promise.withResolvers<unknown>();
	let opens = 0;
	let disposals = 0;
	const source = {
		kind: "stream" as const,
		duration: 60,
		open: async () => {
			opens++;
			return () => ({
				mime: "audio/mp4",
				audio: new ReadableStream<Uint8Array>(),
				dispose() {
					disposals++;
				},
			});
		},
	};
	const prepareStream = async () => {
		const pending = deck.mount(source, {
			...prepare,
			onPlaybackError: failure.resolve,
		});
		await Promise.resolve();
		const id = commands.findLast((command) => command.op === "load")?.id;
		ready(id);
		await pending;
		return id;
	};
	try {
		const first = await prepareStream();
		fail(first, "Decoder lost the stream");
		expect(await failure.promise).toHaveProperty(
			"message",
			"Decoder lost the stream",
		);
		expect(deck.ready).toBe(false);
		expect(media.src).toBe("");
		await Promise.resolve();
		expect(disposals).toBe(1);
		const second = await prepareStream();
		expect(deck.ready).toBe(true);
		expect(second).not.toBe(first);
		expect(opens).toBe(2);
	} finally {
		deck.reset();
		media.dispose();
	}
});
