import { invoke } from "@tauri-apps/api/core";
import type { AudioStreamSession } from "./media-buffer";

export const NATIVE_AUDIO_EVENT = "yumusic-native-audio";
export interface NativeAudioEvent {
	type: "state" | "stream" | "error" | "control";
	deck?: number;
	id?: string;
	epoch?: number;
	position?: number;
	duration?: number;
	buffered?: number;
	paused?: boolean;
	ready?: boolean;
	ended?: boolean;
	message?: string;
	action?: string;
}
export interface NativeAudioBridge {
	events: EventTarget;
	command: (command: Record<string, unknown>) => Promise<void>;
	append: (batch: {
		deck: number;
		id: string;
		epoch: number;
		data: string;
	}) => Promise<boolean>;
}

function delay(signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const done = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(done, 80);
		const abort = () => {
			clearTimeout(timer);
			reject(new DOMException("Audio stopped", "AbortError"));
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/** Media-element-compatible clock and controls backed by Android's native decks.
 * No HTML audio/video element, MediaSource or Web Audio decoder runs on Android. */
export class NativeAudioElement extends EventTarget {
	src = "";
	duration = 0;
	readyState = 0;
	paused = true;
	ended = false;
	seeking = false;
	error: { code: number; message: string } | null = null;
	private id = "";
	private position = 0;
	private clockAt = 0;
	private ahead = 0;
	private level = 0.1;
	private speed = 1;
	private seekTarget: number | null = null;
	private onReady: (() => void) | null = null;
	private onStream: ((epoch: number, position: number) => void) | null = null;
	private onFailure: ((error: Error) => void) | null = null;
	private readonly bridge: NativeAudioBridge;
	constructor(
		readonly deck: number,
		bridge?: NativeAudioBridge,
	) {
		super();
		this.bridge = bridge ?? {
			events: window,
			command: (command) => invoke("native_audio_command", { command }),
			append: (batch) => invoke("native_audio_append", batch),
		};
		this.bridge.events.addEventListener(NATIVE_AUDIO_EVENT, this.receive);
	}
	private emit(type: string) {
		this.dispatchEvent(new Event(type));
	}
	private receive = (event: Event) => {
		const state = (event as CustomEvent<NativeAudioEvent>).detail;
		if (state.deck !== this.deck || state.id !== this.id || !this.id) return;
		if (state.type === "stream") {
			this.onStream?.(state.epoch ?? 0, state.position ?? 0);
			return;
		}
		if (state.type === "error") {
			this.failed(new Error(state.message ?? "Native audio failed"));
			return;
		}
		if (state.type !== "state" || this.error) return;
		const wasPaused = this.paused;
		const wasEnded = this.ended;
		this.position = this.seekTarget ?? state.position ?? 0;
		this.clockAt = performance.now();
		this.ahead = state.buffered ?? 0;
		this.paused = state.paused ?? true;
		this.ended = state.ended ?? false;
		this.readyState = state.ready ? 4 : this.onReady ? 0 : 2;
		if (state.duration && state.duration !== this.duration) {
			this.duration = state.duration;
			this.emit("durationchange");
		}
		if (
			this.seekTarget !== null &&
			Math.abs((state.position ?? 0) - this.seekTarget) < 0.5 &&
			state.ready
		) {
			this.seekTarget = null;
			this.seeking = false;
			this.emit("seeked");
		}
		if (state.ready && this.onReady) {
			const ready = this.onReady;
			this.onReady = null;
			this.emit("loadedmetadata");
			this.emit("canplay");
			ready();
		}
		if (wasPaused !== this.paused) this.emit(this.paused ? "pause" : "play");
		this.emit("timeupdate");
		if (this.ended && !wasEnded) this.emit("ended");
	};
	get currentTime() {
		const elapsed =
			!this.paused && !this.seeking && this.readyState >= 3 && !this.ended
				? ((performance.now() - this.clockAt) / 1000) * this.speed
				: 0;
		return Math.min(this.duration || Infinity, this.position + elapsed);
	}
	set currentTime(value: number) {
		if (!Number.isFinite(value)) return;
		this.position = Math.max(0, Math.min(this.duration || Infinity, value));
		this.seekTarget = this.position;
		this.seeking = true;
		this.emit("seeking");
		void this.command("seek", { value: this.position }).catch(this.failed);
	}
	get volume() {
		return this.level;
	}
	set volume(value: number) {
		if (!Number.isFinite(value) || value === this.level) return;
		this.level = Math.min(1, Math.max(0, value));
		void this.command("volume", { value: this.level }).catch(this.failed);
	}
	get playbackRate() {
		return this.speed;
	}
	set playbackRate(value: number) {
		if (!Number.isFinite(value) || value === this.speed) return;
		this.position = this.currentTime;
		this.clockAt = performance.now();
		this.speed = value;
		void this.command("rate", { value }).catch(this.failed);
	}
	get buffered(): TimeRanges {
		const end = this.ahead;
		return { length: end > 0 ? 1 : 0, start: () => 0, end: () => end };
	}
	private command(op: string, data: Record<string, unknown> = {}) {
		if (!this.id) return Promise.resolve();
		return this.bridge.command({ op, deck: this.deck, id: this.id, ...data });
	}
	private failed = (error: unknown) => {
		if (error instanceof Error && error.name === "AbortError") return;
		const failure = error instanceof Error ? error : new Error(String(error));
		this.error = { code: 3, message: failure.message };
		this.paused = true;
		this.readyState = 0;
		// A normal load marks React as playing before the native deck is ready.
		// Even a failure before the first play event must clear that intent.
		this.emit("pause");
		this.emit("error");
		this.onFailure?.(failure);
	};
	async play() {
		try {
			await this.command("play");
		} catch (error) {
			this.failed(error);
			throw error;
		}
	}
	pause() {
		void this.command("pause").catch(this.failed);
	}
	removeAttribute(name: string) {
		if (name === "src") this.src = "";
	}
	load() {
		if (this.src) return;
		void this.command("stop").catch(this.failed);
		this.id = "";
		this.readyState = 0;
		this.paused = true;
	}

	private async begin(
		data: Record<string, unknown>,
		duration: number,
		ready: () => void,
	) {
		this.id = crypto.randomUUID();
		this.src = `native:${this.id}`;
		this.error = null;
		this.position = this.ahead = 0;
		this.seekTarget = null;
		this.seeking = this.ended = false;
		this.paused = true;
		this.readyState = 0;
		this.duration = duration;
		this.onReady = ready;
		await this.command("load", { ...data, duration });
		await this.command("volume", { value: this.level });
		await this.command("rate", { value: this.speed });
	}

	async mountStream(
		create: (startTimeMs: number) => AudioStreamSession,
		options: {
			signal: AbortSignal;
			duration: number;
			onReady: () => void;
			autoPlay?: boolean;
		},
	) {
		options.signal.throwIfAborted();
		let first: AudioStreamSession | null = create(0);
		const mime = first.mime;
		const producer: { current: AbortController | null } = { current: null };
		let rejectFailure!: (error: Error) => void;
		const failure = new Promise<never>((_, reject) => {
			rejectFailure = reject;
		});
		this.onFailure = rejectFailure;
		this.onStream = (epoch, position) => {
			producer.current?.abort();
			const controller = new AbortController();
			producer.current = controller;
			const source = position === 0 && first ? first : create(position * 1000);
			if (first && first !== source) first.dispose();
			first = null;
			const id = this.id;
			void this.pump(source, id, epoch, controller.signal).catch(
				(error: unknown) => {
					if (!controller.signal.aborted)
						rejectFailure(
							error instanceof Error ? error : new Error(String(error)),
						);
				},
			);
		};
		let stopped!: () => void;
		const done = new Promise<void>((resolve) => {
			stopped = resolve;
		});
		options.signal.addEventListener("abort", stopped, { once: true });
		const started = this.begin(
			{ mime, autoPlay: !!options.autoPlay },
			options.duration,
			options.onReady,
		);
		const mountId = this.id;
		try {
			await Promise.race([started, failure]);
			if (options.signal.aborted) return;
			await Promise.race([done, failure]);
		} finally {
			options.signal.removeEventListener("abort", stopped);
			producer.current?.abort();
			first?.dispose();
			if (this.id === mountId)
				this.onStream = this.onFailure = this.onReady = null;
		}
	}

	private async pump(
		source: AudioStreamSession,
		id: string,
		epoch: number,
		signal: AbortSignal,
	) {
		const reader = source.audio.getReader();
		const stop = () => {
			void reader.cancel().catch(() => undefined);
			source.dispose();
		};
		signal.addEventListener("abort", stop, { once: true });
		try {
			while (!signal.aborted && this.id === id) {
				const { value, done } = await reader.read();
				if (done) {
					if (!signal.aborted && this.id === id)
						await this.command("end", { epoch });
					return;
				}
				for (
					let offset = 0;
					offset < value.length && !signal.aborted;
					offset += 65536
				) {
					const bytes = value.subarray(offset, offset + 65536);
					let binary = "";
					for (const byte of bytes) binary += String.fromCharCode(byte);
					const data = btoa(binary);
					while (
						!signal.aborted &&
						this.id === id &&
						!(await this.bridge.append({ deck: this.deck, id, epoch, data }))
					)
						await delay(signal);
				}
			}
		} catch (error) {
			if (!signal.aborted && this.id === id)
				await this.command("end", { epoch, error: String(error) }).catch(
					() => undefined,
				);
			throw error;
		} finally {
			signal.removeEventListener("abort", stop);
			stop();
			reader.releaseLock();
		}
	}

	async mountFile(
		path: string,
		duration: number,
		signal: AbortSignal,
		autoPlay = false,
	) {
		signal.throwIfAborted();
		let ready!: () => void;
		let failed!: (error: Error) => void;
		const waiting = new Promise<void>((resolve, reject) => {
			ready = resolve;
			failed = reject;
		});
		this.onFailure = failed;
		const abort = () => failed(new DOMException("Audio stopped", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		const started = this.begin({ path, autoPlay }, duration, ready);
		const mountId = this.id;
		try {
			await Promise.race([started.then(() => waiting), waiting]);
		} finally {
			signal.removeEventListener("abort", abort);
			if (this.id === mountId) this.onFailure = this.onReady = null;
		}
	}

	dispose() {
		this.src = "";
		this.load();
		this.bridge.events.removeEventListener(NATIVE_AUDIO_EVENT, this.receive);
	}
}

export function nativeAudio(
	media: HTMLMediaElement,
): NativeAudioElement | null {
	return media instanceof NativeAudioElement ? media : null;
}
