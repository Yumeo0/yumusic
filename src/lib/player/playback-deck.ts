import { convertFileSrc } from "@tauri-apps/api/core";
import type { RefObject } from "react";
import { type AudioStreamSession, mountBufferedAudio } from "./media-buffer";
import { NativeAudioElement } from "./native-audio";

export type PlaybackMedia = HTMLVideoElement | NativeAudioElement;

export type DeckSource =
	| { kind: "file"; path: string; duration: number }
	| {
			kind: "stream";
			duration: number;
			open: (
				signal: AbortSignal,
			) => Promise<(offsetMs: number) => AudioStreamSession>;
	  };

interface MountOptions {
	autoPlay: boolean;
	volume: () => number;
	onPlaybackError?: (error: unknown) => void;
}

export class PlaybackDeck {
	#mount: { controller: AbortController; ready: boolean } | null = null;

	constructor(readonly ref: RefObject<PlaybackMedia | null>) {}

	get ready() {
		return this.#mount?.ready ?? false;
	}

	async play() {
		const media = this.ref.current;
		if (!media) throw new Error("This track is unavailable on this device.");
		try {
			await media.play();
			return true;
		} catch (error) {
			// A browser can leave a playable track paused until a user gesture.
			if (
				error instanceof Error &&
				(error.name === "NotAllowedError" || error.name === "AbortError")
			)
				return false;
			throw error;
		}
	}

	reset() {
		const mount = this.#mount;
		this.#mount = null;
		mount?.controller.abort();
		const media = this.ref.current;
		if (!media) return;
		// Native load() sends stop. A separate pause would undo a completed fade.
		if (!(media instanceof NativeAudioElement)) media.pause();
		if (media.src) {
			media.removeAttribute("src");
			media.load();
		}
	}

	async mount(source: DeckSource, options: MountOptions) {
		const media = this.ref.current;
		if (!media) throw new Error("This track is unavailable on this device.");
		this.reset();
		const controller = new AbortController();
		const mount = { controller, ready: false };
		this.#mount = mount;
		const { signal } = controller;
		const readiness = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
		const native = media instanceof NativeAudioElement;
		const fail = (error: unknown) => {
			if (this.#mount !== mount || signal.aborted) return;
			if (mount.ready) {
				this.reset();
				options.onPlaybackError?.(error);
			} else {
				controller.abort(error);
			}
		};
		media.addEventListener("error", () => fail(mediaError(media)), { signal });
		media.volume = options.volume();
		try {
			if (source.kind === "file") {
				if (native) {
					await media.mountFile(
						source.path,
						source.duration,
						readiness,
						options.autoPlay,
					);
				} else {
					media.src = convertFileSrc(source.path);
					media.load();
				}
			} else {
				void source
					.open(signal)
					.then((createSession) => {
						signal.throwIfAborted();
						const stream = {
							signal,
							duration: source.duration,
							autoPlay: options.autoPlay,
						};
						return native
							? media.mountStream(createSession, stream)
							: mountBufferedAudio(media, createSession, stream);
					})
					.catch(fail);
			}
			await waitForPlayable(media, readiness);
			if (options.autoPlay && !native) {
				media.volume = options.volume();
				await this.play();
			}
			signal.throwIfAborted();
			mount.ready = true;
		} catch (error) {
			if (this.#mount === mount) this.reset();
			throw error;
		}
	}
}

function mediaError(media: PlaybackMedia): Error {
	const error = media.error;
	return new Error(
		error?.message ||
			(error ? `Media error ${error.code}` : "Audio playback failed"),
	);
}

function waitForPlayable(media: PlaybackMedia, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const events = ["loadeddata", "canplay"];
		const finish = (error?: unknown) => {
			for (const event of events) media.removeEventListener(event, check);
			signal.removeEventListener("abort", check);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (signal.aborted) finish(signal.reason);
			else if (media.error) finish(mediaError(media));
			else if (media.readyState >= 2) finish();
		};
		for (const event of events) media.addEventListener(event, check);
		signal.addEventListener("abort", check);
		check();
	});
}
