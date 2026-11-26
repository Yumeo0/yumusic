import { convertFileSrc } from "@tauri-apps/api/core";
import type { RefObject } from "react";
import type { Innertube, YT } from "youtubei.js/web";
import type { DownloadEntry } from "@/lib/downloads/downloads";
import type { Song } from "@/lib/music/song";
import { parseDuration } from "@/lib/utils/utils";
import { nativeAudio } from "./native-audio";
import { mountSabrAudio } from "./sabr-audio";

/**
 * One of the two hidden media elements the player renders and swaps between.
 * The idle deck buffers the next track so a crossfade can overlap the two.
 */
export interface Deck {
	/** The hidden media element this deck outputs through. */
	ref: RefObject<HTMLVideoElement | null>;
	/**
	 * Video id mounted on the element (a load in progress counts). Null while
	 * idle; the guard that keeps a crossfade promotion from re-loading the
	 * track that is already mounted.
	 */
	videoId: string | null;
	/** True once audio chunks have been appended and the deck can play. */
	ready: boolean;
	/** Aborts this deck's reader and tears down its MediaSource. */
	mount: { controller: AbortController; readiness: AbortSignal } | null;
}

export interface LoadedStream {
	videoInfo: YT.VideoInfo;
	innertube: Innertube;
}

interface MountOptions {
	/** Start playback as soon as the first chunks land (normal loads). */
	autoPlay: boolean;
	volume: () => number;
	/** Called once the deck is buffered enough to play (crossfade preloads). */
	onReady?: () => void;
}

export function resetDeck(deck: Deck) {
	deck.videoId = null;
	deck.ready = false;
	deck.mount?.controller.abort();
	deck.mount = null;
	const media = deck.ref.current;
	if (!media) return;
	// Native load() sends stop. A separate pause would undo a completed fade.
	if (!nativeAudio(media)) media.pause();
	if (media.src) {
		media.removeAttribute("src");
		media.load();
	}
}

function attach(deck: Deck, id: string) {
	const media = deck.ref.current;
	if (!media) return null;
	resetDeck(deck);
	const controller = new AbortController();
	const readiness = AbortSignal.any([
		controller.signal,
		AbortSignal.timeout(30_000),
	]);
	deck.mount = { controller, readiness };
	deck.videoId = id;
	return { controller, media, readiness, signal: controller.signal };
}

export async function mountStreamDeck(
	deck: Deck,
	stream: LoadedStream,
	options: MountOptions,
) {
	const { videoInfo, innertube } = stream;
	const { id, is_live, is_post_live_dvr } = videoInfo.basic_info;
	if (!id || !videoInfo.streaming_data || is_live || is_post_live_dvr) return;
	const mounted = attach(deck, id);
	if (!mounted) return;
	const { controller, media, signal } = mounted;
	try {
		await mountSabrAudio(media, videoInfo, innertube, {
			signal,
			autoPlay: options.autoPlay,
			onReady: () => {
				if (signal.aborted) return;
				deck.ready = true;
				if (options.autoPlay) {
					media.volume = options.volume();
					void media.play().catch((error) => {
						if (error.name !== "AbortError")
							console.error("[player] Auto-playback failed:", error);
					});
				}
				options.onReady?.();
			},
		});
	} catch (error) {
		if (signal.aborted) return;
		console.error("[player] Could not mount stream:", error);
		deck.videoId = null;
		deck.ready = false;
		controller.abort(error);
	}
}

function waitForReadyState(
	media: HTMLMediaElement,
	state: number,
	event: string,
	signal: AbortSignal,
) {
	return new Promise<void>((resolve, reject) => {
		const finish = (error?: unknown) => {
			media.removeEventListener("canplay", check);
			media.removeEventListener(event, check);
			media.removeEventListener("error", check);
			signal.removeEventListener("abort", check);
			if (error) reject(error);
			else resolve();
		};
		const check = () => {
			if (signal.aborted) finish(signal.reason);
			else if (media.error)
				finish(new Error(`Media error ${media.error.code}`));
			else if (media.readyState >= state) finish();
		};
		media.addEventListener("canplay", check);
		media.addEventListener(event, check);
		media.addEventListener("error", check);
		signal.addEventListener("abort", check);
		check();
	});
}

export async function waitForDeckData(deck: Deck) {
	const media = deck.ref.current;
	const mount = deck.mount;
	if (!media || !mount)
		throw new Error("This track is unavailable on this device.");
	try {
		await waitForReadyState(media, 2, "loadeddata", mount.readiness);
	} catch (error) {
		if (deck.mount === mount) resetDeck(deck);
		throw error;
	}
}

export async function mountLocalDeck(
	deck: Deck,
	song: Song,
	entry: DownloadEntry,
	options: MountOptions,
) {
	const mounted = attach(deck, song.id);
	if (!mounted) return false;
	const { controller, media, readiness, signal } = mounted;
	const native = nativeAudio(media);
	try {
		if (native) {
			await native.mountFile(
				entry.path,
				parseDuration(song.duration),
				readiness,
				options.autoPlay,
			);
			signal.throwIfAborted();
			if (options.autoPlay) {
				native.volume = options.volume();
				void native.play().catch(() => undefined);
			}
		} else {
			media.volume = options.volume();
			media.src = convertFileSrc(entry.path);
			media.load();
			if (options.autoPlay) await media.play();
			else await waitForReadyState(media, 1, "loadedmetadata", readiness);
		}
		deck.ready = true;
		options.onReady?.();
		return true;
	} catch (error) {
		if (signal.aborted) return false;
		if (
			!readiness.aborted &&
			options.autoPlay &&
			error instanceof Error &&
			error.name === "AbortError"
		)
			return true;
		console.warn(
			"[player] Could not play downloaded audio:",
			entry.path,
			error,
		);
		deck.videoId = null;
		deck.ready = false;
		controller.abort(error);
		return false;
	}
}
