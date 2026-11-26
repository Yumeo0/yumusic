import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { Song } from "@/lib/music/song";
import { readFreshPlaylistView } from "@/lib/stores/playlist-cache";
import {
	getSettings,
	subscribeToSettings,
	updateSettings,
	useSettings,
} from "@/lib/stores/settings";
import { showToast } from "@/lib/stores/toast";
import { bytesToBase64 } from "@/lib/utils/base64";
import { applySongDescription } from "@/lib/utils/description";
import { getPlaybackStream } from "@/lib/youtube/playback-stream";
import { loadPlaylistView } from "@/lib/youtube/playlist-data";
import { rememberSongDescription } from "@/lib/youtube/song-description";
import { canonicalPlaylistId } from "../youtube/playlist-id";

/**
 * Download manager: saves songs as audio files in the app's data directory
 * (through the Rust commands in `src-tauri/src/downloads.rs`) so they can be
 * played from disk. Downloads use the same SABR pipeline as playback, so the
 * bytes stored are exactly what the media element would stream.
 *
 * The completed-entry index is owned by the Rust side and hydrated on startup;
 * this module mirrors it in memory and exposes it reactively.
 */

export interface DownloadEntry {
	id: string;
	title: string;
	artist: string;
	duration: string | null;
	thumbnail: string | null;
	/** Uploader description, used to refine the title/artist on playback. */
	description: string | null;
	ext: string;
	size: number;
	/** Absolute file path, loaded through the Tauri asset protocol. */
	path: string;
	downloadedAt: number;
}

export type DownloadStatus =
	| { phase: "queued"; song: Song }
	| { phase: "downloading"; progress: number | null; song: Song }
	| { phase: "error"; song: Song };

interface PlaylistDownloadJob {
	title: string;
	total: number;
	done: number;
	failed: number;
	discovering: boolean;
}

interface PlaylistJob {
	id: string;
	controller: AbortController;
	seen: Set<string>;
	progress: PlaylistDownloadJob;
}

interface DownloadTask {
	song: Song;
	phase: "downloading" | "queued";
	progress: number | null;
}

interface DownloadsSnapshot {
	entries: ReadonlyMap<string, DownloadEntry>;
	tasks: DownloadTask[];
	failed: Song[];
	totalBytes: number;
}

const CHUNK_BYTES = 512 * 1024;

let entries = new Map<string, DownloadEntry>();
let totalBytes = 0;
const statuses = new Map<string, DownloadStatus>();
const jobs = new Map<string, PlaylistJob>();
let snapshot: DownloadsSnapshot | null = null;
const listeners = new Set<() => void>();
let progressTimer: ReturnType<typeof setTimeout> | undefined;

function replaceEntries(next: Map<string, DownloadEntry>) {
	entries = next;
	totalBytes = 0;
	for (const entry of next.values()) totalBytes += entry.size;
}

function emit() {
	clearTimeout(progressTimer);
	progressTimer = undefined;
	snapshot = null;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): DownloadsSnapshot {
	if (!snapshot) {
		const tasks: DownloadTask[] = [];
		for (const { item, controller } of active.values()) {
			if (controller.signal.aborted) continue;
			const status = statuses.get(item.song.id);
			tasks.push({
				phase: "downloading",
				progress: status?.phase === "downloading" ? status.progress : null,
				song: item.song,
			});
		}
		for (const item of queue.values()) {
			tasks.push({ phase: "queued", progress: null, song: item.song });
		}
		const failed: Song[] = [];
		for (const status of statuses.values()) {
			if (status.phase === "error") failed.push(status.song);
		}

		snapshot = {
			entries,
			failed,
			tasks,
			totalBytes,
		};
	}
	return snapshot;
}

export function useDownloads(): DownloadsSnapshot {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getDownloadEntry(id: string): DownloadEntry | undefined {
	return entries.get(id);
}

export function useDownloadEntry(id: string | undefined) {
	const entry = () => (id ? entries.get(id) : undefined);
	return useSyncExternalStore(subscribe, entry, entry);
}

export function useDownloadStatus(id: string | undefined) {
	const status = () => (id ? statuses.get(id) : undefined);
	return useSyncExternalStore(subscribe, status, status);
}

export function usePlaylistDownloadJob(id: string | undefined) {
	const job = () =>
		id ? jobs.get(canonicalPlaylistId(id))?.progress : undefined;
	return useSyncExternalStore(subscribe, job, job);
}

export function playlistDownloadLabel(job: PlaylistDownloadJob): string {
	if (job.total === 0) return "Finding tracks…";
	const progress = `Downloading ${job.done}/${job.total}`;
	return job.discovering ? `${progress} · finding tracks` : progress;
}

let hydratePromise: Promise<boolean> | null = null;
export function hydrateDownloads(): Promise<boolean> {
	if (!isTauri()) return Promise.resolve(false);
	hydratePromise ??= invoke<DownloadEntry[]>("downloads_list").then(
		(stored) => {
			replaceEntries(
				new Map([
					...stored.map((entry) => [entry.id, entry] as const),
					...entries,
				]),
			);
			emit();
			return true;
		},
		(error: unknown) => {
			hydratePromise = null;
			console.warn("[downloads] could not load the index:", error);
			return false;
		},
	);
	return hydratePromise;
}

interface QueueItem {
	song: Song;
	jobs: Set<PlaylistJob>;
	standalone: boolean;
}

interface PreparedDownload {
	result: Awaited<ReturnType<typeof getPlaybackStream>>;
	createSource: typeof import("@/lib/youtube/sabr-source").createSabrAudioSource;
}

interface Preparation {
	item: QueueItem;
	controller: AbortController;
	ready?: PreparedDownload;
}

interface Transfer {
	item: QueueItem;
	controller: AbortController;
	settled: Promise<void>;
}

const queue = new Map<string, QueueItem>();
const active = new Map<string, Transfer>();
const removing = new Set<string>();
let preparation: Preparation | undefined;
let pumping = false;
let unwatchSettings: (() => void) | undefined;

function finishJobIfReady(job: PlaylistJob) {
	const { discovering, done, total } = job.progress;
	if (!discovering && done === total && jobs.get(job.id) === job)
		jobs.delete(job.id);
}

function settle(item: QueueItem, ok: boolean) {
	for (const job of item.jobs) {
		const { done, failed } = job.progress;
		job.progress = {
			...job.progress,
			done: done + 1,
			failed: failed + (ok ? 0 : 1),
		};
		finishJobIfReady(job);
	}
}

export function dismissDownloadError(id: string) {
	const status = statuses.get(id);
	if (status?.phase !== "error") return;
	statuses.delete(id);
	emit();
}

async function pump() {
	if (pumping) return;
	if (!queue.size) {
		if (!active.size) {
			unwatchSettings?.();
			unwatchSettings = undefined;
		}
		return;
	}
	pumping = true;
	try {
		await hydrateDownloads();
		if (preparation?.ready && active.size < getSettings().parallelDownloads) {
			const { item, controller, ready } = preparation;
			preparation = undefined;
			queue.delete(item.song.id);
			startTransfer(item, controller, ready);
		}
		// Keep one resolution in flight or ready ahead of the transfers.
		for (const item of queue.values()) {
			if (preparation) break;
			// A retry can be queued while the cancelled transfer cleans up its file.
			if (active.has(item.song.id)) continue;
			if (!entries.has(item.song.id)) {
				startPreparation(item);
				break;
			}
			queue.delete(item.song.id);
			statuses.delete(item.song.id);
			settle(item, true);
			emit();
		}
	} finally {
		pumping = false;
		if (!queue.size && !active.size) {
			unwatchSettings?.();
			unwatchSettings = undefined;
		}
	}
}

function startPreparation(item: QueueItem) {
	const pending: Preparation = { item, controller: new AbortController() };
	preparation = pending;
	void Promise.all([
		getPlaybackStream(item.song.id, pending.controller.signal, true),
		import("@/lib/youtube/sabr-source"),
	]).then(
		([result, { createSabrAudioSource }]) => {
			if (preparation !== pending) return;
			pending.ready = { result, createSource: createSabrAudioSource };
			void pump();
		},
		(error: unknown) => {
			if (preparation !== pending) return;
			preparation = undefined;
			queue.delete(item.song.id);
			failDownload(item, pending.controller.signal, error);
			emit();
			void pump();
		},
	);
}

function failDownload(item: QueueItem, signal: AbortSignal, error: unknown) {
	if (signal.aborted) {
		if (!queue.has(item.song.id)) statuses.delete(item.song.id);
	} else {
		statuses.set(item.song.id, { phase: "error", song: item.song });
		console.error("[downloads] download failed:", error);
	}
	settle(item, false);
}

function startTransfer(
	item: QueueItem,
	controller: AbortController,
	prepared: PreparedDownload,
) {
	const { song } = item;
	const settled = runDownload(song, prepared, controller.signal)
		.then(
			() => {
				if (!queue.has(song.id)) statuses.delete(song.id);
				settle(item, true);
			},
			(error: unknown) => failDownload(item, controller.signal, error),
		)
		.finally(() => {
			active.delete(song.id);
			emit();
			void pump();
		});
	active.set(song.id, { item, controller, settled });
	statuses.set(song.id, { phase: "downloading", progress: null, song });
	emit();
}

async function runDownload(
	song: Song,
	{ result, createSource }: PreparedDownload,
	signal: AbortSignal,
) {
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let disposeStream: (() => void) | undefined;
	const closeStream = () => {
		disposeStream?.();
		disposeStream = undefined;
		return reader?.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", closeStream, { once: true });

	let token: string | null = null;
	let pendingWrite: Promise<void> | undefined;
	let lastProgressEmit = 0;
	try {
		signal.throwIfAborted();
		const videoInfo = result.videoInfo;
		// Keep the uploader description with the stored song: playback uses it
		// to refine the parsed title/artist, and it is saved in the index.
		const description =
			videoInfo.basic_info.short_description?.trim() ||
			song.description ||
			null;
		if (description) rememberSongDescription(song.id, description);
		// Store the resolved credits, so the downloads list and offline
		// playback show the same title/artist as the streamed track.
		const enriched = description
			? applySongDescription(song, description)
			: song;
		const createAudio = await createSource(
			result.videoId,
			videoInfo,
			result.innertube,
			signal,
			{ background: true, downloadQuality: getSettings().downloadQuality },
		);
		signal.throwIfAborted();
		const { audio, mime, contentLength: totalBytes, dispose } = createAudio();
		disposeStream = dispose;
		// Both containers are detected from their magic bytes by the asset
		// protocol, and `.mp4` also has a safe MIME fallback if not.
		const ext = mime.includes("webm")
			? "webm"
			: mime.includes("mp4")
				? "mp4"
				: "bin";

		token = await invoke<string>("download_begin", { songId: song.id, ext });
		signal.throwIfAborted();

		reader = audio.getReader();
		let pending: Uint8Array[] = [];
		let pendingBytes = 0;
		let received = 0;

		const flush = async () => {
			if (pendingBytes === 0) return;
			await pendingWrite;
			signal.throwIfAborted();
			const merged = new Uint8Array(pendingBytes);
			let offset = 0;
			for (const chunk of pending) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}
			pending = [];
			pendingBytes = 0;
			pendingWrite = invoke<void>("download_append", {
				data: bytesToBase64(merged),
				token,
			});
			// Let the next batch arrive while this write is in progress.
			void pendingWrite.catch(closeStream);
		};

		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done || signal.aborted) break;
			if (!value || value.byteLength === 0) continue;
			pending.push(value);
			pendingBytes += value.byteLength;
			received += value.byteLength;
			// The list re-renders on progress; a few updates per second suffice.
			const now = performance.now();
			if (now - lastProgressEmit > 250) {
				lastProgressEmit = now;
				statuses.set(song.id, {
					phase: "downloading",
					progress: totalBytes > 0 ? Math.min(1, received / totalBytes) : null,
					song,
				});
				progressTimer ??= setTimeout(emit, 80);
			}
			if (pendingBytes >= CHUNK_BYTES) await flush();
		}
		signal.throwIfAborted();
		await flush();
		await pendingWrite;
		signal.throwIfAborted();

		const entry = await invoke<DownloadEntry>("download_finish", {
			metadata: {
				artist: enriched.artist,
				description,
				duration: enriched.duration ?? null,
				thumbnail: enriched.thumbnail || null,
				title: enriched.title,
			},
			token,
		});
		token = null;
		replaceEntries(new Map(entries).set(entry.id, entry));
	} catch (error) {
		await pendingWrite?.catch(() => undefined);
		if (token) {
			try {
				await invoke("download_abort", { token });
			} catch {
				// best-effort cleanup
			}
		}
		throw error;
	} finally {
		signal.removeEventListener("abort", closeStream);
		await closeStream();
		reader?.releaseLock();
	}
}

function enqueue(song: Song): QueueItem {
	const queued = queue.get(song.id);
	if (queued) return queued;
	const transfer = active.get(song.id);
	if (transfer && !transfer.controller.signal.aborted) return transfer.item;
	const item = { song, jobs: new Set<PlaylistJob>(), standalone: false };
	queue.set(song.id, item);
	statuses.set(song.id, { phase: "queued", song });
	return item;
}

function publishQueue() {
	emit();
	if (!queue.size) return;
	unwatchSettings ??= subscribeToSettings(() => void pump());
	void pump();
}

export function downloadSong(song: Song) {
	if (!isTauri() || entries.has(song.id) || removing.has(song.id)) return;
	enqueue(song).standalone = true;
	publishQueue();
}

function startJob(
	id: string,
	title: string,
	discovering: boolean,
): PlaylistJob {
	const job = {
		id,
		controller: new AbortController(),
		seen: new Set<string>(),
		progress: { title, done: 0, failed: 0, total: 0, discovering },
	};
	jobs.set(id, job);
	return job;
}

function queuePlaylistTracks(job: PlaylistJob, songs: readonly Song[]) {
	if (job.controller.signal.aborted) return;
	let { total, done } = job.progress;
	for (const song of songs) {
		if (job.seen.has(song.id) || removing.has(song.id)) continue;
		job.seen.add(song.id);
		total++;
		if (entries.has(song.id)) done++;
		else enqueue(song).jobs.add(job);
	}
	job.progress = { ...job.progress, done, total };
	finishJobIfReady(job);
	publishQueue();
}

/**
 * Saves a playlist (or album): uses the supplied track list when the caller
 * already has one, otherwise loads it. The menu shows aggregate progress
 * through the `jobs` map while this runs.
 */
function downloadPlaylist(
	id: string,
	title: string,
	songs?: Song[],
	complete = songs !== undefined,
) {
	if (jobs.has(id)) return;
	const cached = songs === undefined ? readFreshPlaylistView(id) : null;
	const known = songs ?? cached?.songs ?? [];
	const job = startJob(id, title, !complete && !cached);
	queuePlaylistTracks(job, known);
	if (!job.progress.discovering) {
		if (!known.length) showToast("Playlist is empty");
		return;
	}
	void (async () => {
		const { signal } = job.controller;
		try {
			const view = await loadPlaylistView(id, {
				signal,
				onFirstPage: (first) => queuePlaylistTracks(job, first.songs),
				onContinuation: (batch) => queuePlaylistTracks(job, batch),
			});
			if (signal.aborted) return;
			if (!view) throw new Error("Could not load playlist");
			if (!view.complete) showToast("Could not load the rest of the playlist");
			else if (!job.seen.size) showToast("Playlist is empty");
		} catch (error) {
			if (!signal.aborted) {
				console.error("[downloads] playlist load failed:", error);
				showToast("Could not load playlist");
			}
		} finally {
			if (!signal.aborted) {
				job.progress = { ...job.progress, discovering: false };
				finishJobIfReady(job);
				emit();
			}
		}
	})();
}

function isSamePlaylist(id: string, saved: string) {
	return canonicalPlaylistId(saved) === canonicalPlaylistId(id);
}

function isPlaylistDownloaded(
	id: string,
	saved = getSettings().downloadedPlaylists,
) {
	return saved.some((playlist) => isSamePlaylist(id, playlist));
}

export function usePlaylistDownloaded(id: string): boolean {
	const [settings] = useSettings();
	return isPlaylistDownloaded(id, settings.downloadedPlaylists);
}

/**
 * Toggles "keep this playlist downloaded". Turning it on starts a download of
 * everything missing right away; while it stays on, `syncDownloadedPlaylist`
 * queues new additions whenever the playlist's songs are loaded. Turning it
 * off stops current and future playlist downloads and keeps the saved files.
 */
export function togglePlaylistDownload(
	id: string,
	title: string,
	songs?: Song[],
	complete?: boolean,
) {
	if (!isTauri()) return;
	const { downloadedPlaylists } = getSettings();
	if (isPlaylistDownloaded(id, downloadedPlaylists)) {
		stopPlaylistDownload(id);
		return;
	}
	const canonicalId = canonicalPlaylistId(id);
	updateSettings({
		downloadedPlaylists: [...downloadedPlaylists, canonicalId],
	});
	downloadPlaylist(canonicalId, title, songs, complete);
}

/**
 * Queues anything missing from a subscribed playlist; a no-op for playlists
 * that are not kept downloaded or that are already complete, so it can run on
 * every visit without flickering the queue.
 *
 * Shared downloads are tracked in each job. Failed tracks wait for an
 * explicit retry instead of restarting on every visit.
 */
export async function syncDownloadedPlaylist(
	id: string,
	title: string,
	songs: Song[],
) {
	if (!isTauri() || songs.length === 0 || !isPlaylistDownloaded(id)) return;
	if (!(await hydrateDownloads()) || !isPlaylistDownloaded(id)) return;
	const canonicalId = canonicalPlaylistId(id);
	const currentJob = jobs.get(canonicalId);
	const missing = songs.filter(
		(song) =>
			!entries.has(song.id) &&
			statuses.get(song.id)?.phase !== "error" &&
			!removing.has(song.id) &&
			!currentJob?.seen.has(song.id),
	);
	if (missing.length) {
		const job = currentJob ?? startJob(canonicalId, title, false);
		queuePlaylistTracks(job, missing);
	}
}

/** Stops this playlist's work and turns off automatic downloads for it. */
export function stopPlaylistDownload(id: string) {
	const canonicalId = canonicalPlaylistId(id);
	const { downloadedPlaylists } = getSettings();
	const remaining = downloadedPlaylists.filter(
		(playlist) => !isSamePlaylist(id, playlist),
	);
	if (remaining.length !== downloadedPlaylists.length)
		updateSettings({ downloadedPlaylists: remaining });

	const job = jobs.get(canonicalId);
	if (!job) return;
	jobs.delete(canonicalId);
	job.controller.abort();
	for (const trackId of job.seen) {
		const transfer = active.get(trackId);
		const item: QueueItem | undefined = transfer?.item.jobs.has(job)
			? transfer.item
			: queue.get(trackId);
		if (!item?.jobs.delete(job) || item.standalone || item.jobs.size) continue;
		if (transfer && transfer.item === item) cancelTransfer(transfer);
		else cancelQueuedDownload(item);
	}
	emit();
	void pump();
}

function cancelQueuedDownload(item: QueueItem) {
	if (preparation?.item === item) {
		preparation.controller.abort();
		preparation = undefined;
	}
	queue.delete(item.song.id);
	statuses.delete(item.song.id);
	settle(item, false);
}

function cancelTransfer(transfer: Transfer) {
	transfer.controller.abort();
	if (!queue.has(transfer.item.song.id)) statuses.delete(transfer.item.song.id);
}

export function cancelDownload(id: string) {
	const queued = queue.get(id);
	const transfer = active.get(id);
	if (queued) cancelQueuedDownload(queued);
	else if (transfer) cancelTransfer(transfer);
	else return;
	emit();
	void pump();
}

export async function removeDownloads(ids: string[]) {
	const targets = [...new Set(ids)].filter((id) => !removing.has(id));
	if (targets.length === 0) return;
	const transfers = targets.map((id) => active.get(id)?.settled);
	for (const id of targets) {
		removing.add(id);
		cancelDownload(id);
	}
	try {
		await hydrateDownloads();
		await Promise.all(transfers);
		const failed = await invoke<string[]>("downloads_remove", { ids: targets });
		const failedIds = new Set(failed);
		const next = new Map(entries);
		// Entries whose file could not be deleted stay listed.
		for (const id of targets) {
			if (!failedIds.has(id)) next.delete(id);
		}
		replaceEntries(next);
		emit();
		if (failed.length > 0) {
			showToast(
				failed.length === 1
					? "Download is in use and was not removed"
					: "Some downloads are in use and were not removed",
			);
		} else {
			showToast(
				targets.length === 1 ? "Download removed" : "Downloads removed",
			);
		}
	} catch (error) {
		console.error("[downloads] removal failed:", error);
		showToast("Could not remove downloads");
	} finally {
		for (const id of targets) removing.delete(id);
	}
}
