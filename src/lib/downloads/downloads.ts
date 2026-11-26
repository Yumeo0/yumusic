import { invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { Song } from "@/lib/music/song";
import {
	getSettings,
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
 * this module mirrors it in memory and exposes it reactively. One song is
 * downloaded at a time and the rest wait in a queue.
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
const statuses = new Map<string, DownloadStatus>();
const jobs = new Map<string, PlaylistDownloadJob>();
let snapshot: DownloadsSnapshot | null = null;
const listeners = new Set<() => void>();

function emit() {
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
		let totalBytes = 0;
		for (const entry of entries.values()) totalBytes += entry.size;

		const tasks: DownloadTask[] = [];
		if (current) {
			const status = statuses.get(current.song.id);
			tasks.push({
				phase: "downloading",
				progress: status?.phase === "downloading" ? status.progress : null,
				song: current.song,
			});
		}
		for (const item of queue) {
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
	const job = () => (id ? jobs.get(canonicalPlaylistId(id)) : undefined);
	return useSyncExternalStore(subscribe, job, job);
}

let hydratePromise: Promise<boolean> | null = null;
export function hydrateDownloads(): Promise<boolean> {
	if (!isTauri()) return Promise.resolve(false);
	hydratePromise ??= invoke<DownloadEntry[]>("downloads_list").then(
		(stored) => {
			entries = new Map([
				...stored.map((entry) => [entry.id, entry] as const),
				...entries,
			]);
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
	jobId?: string;
}

let queue: QueueItem[] = [];
let current: {
	song: Song;
	cancel: () => void;
	settled: Promise<void>;
} | null = null;
let pumping = false;

function isBusy(id: string): boolean {
	const status = statuses.get(id);
	return (
		entries.has(id) ||
		(status !== undefined && status.phase !== "error") ||
		current?.song.id === id
	);
}

function settle(item: QueueItem, ok: boolean) {
	if (!item.jobId) return;
	const job = jobs.get(item.jobId);
	if (!job) return;
	const done = job.done + 1;
	if (done >= job.total) {
		finishJob(item.jobId);
		return;
	}
	jobs.set(item.jobId, { ...job, done, failed: job.failed + (ok ? 0 : 1) });
	emit();
}

function finishJob(jobId: string) {
	jobs.delete(jobId);
	emit();
}

export function dismissDownloadError(id: string) {
	const status = statuses.get(id);
	if (status?.phase !== "error") return;
	statuses.delete(id);
	emit();
}

async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		await hydrateDownloads();
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) break;
			if (entries.has(item.song.id)) {
				statuses.delete(item.song.id);
				settle(item, true);
				emit();
				continue;
			}
			const ok = await runDownload(item);
			settle(item, ok);
		}
	} finally {
		pumping = false;
	}
}

/** Buffers `song` to disk. Returns false when it failed (or was cancelled). */
async function runDownload(item: QueueItem): Promise<boolean> {
	const { song } = item;
	const controller = new AbortController();
	const { signal } = controller;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let disposeStream: (() => void) | undefined;
	let finishTransfer!: () => void;
	const settled = new Promise<void>((resolve) => {
		finishTransfer = resolve;
	});
	current = {
		settled,
		cancel: () => {
			controller.abort();
			void reader?.cancel().catch(() => undefined);
			disposeStream?.();
		},
		song,
	};
	statuses.set(song.id, { phase: "downloading", progress: null, song });
	emit();

	let token: string | null = null;
	let lastProgressEmit = 0;
	try {
		const [result, { createSabrAudioSource }] = await Promise.all([
			getPlaybackStream(song.id, signal),
			import("@/lib/youtube/sabr-source"),
		]);
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
		const createAudio = await createSabrAudioSource(
			result.videoId,
			videoInfo,
			result.innertube,
			signal,
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
			const merged = new Uint8Array(pendingBytes);
			let offset = 0;
			for (const chunk of pending) {
				merged.set(chunk, offset);
				offset += chunk.byteLength;
			}
			pending = [];
			pendingBytes = 0;
			await invoke("download_append", {
				data: bytesToBase64(merged),
				token,
			});
		};

		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done) break;
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
				emit();
			}
			if (pendingBytes >= CHUNK_BYTES) await flush();
		}
		signal.throwIfAborted();
		await flush();
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
		entries = new Map(entries).set(entry.id, entry);
		statuses.delete(song.id);
		return true;
	} catch (error) {
		if (token) {
			try {
				await invoke("download_abort", { token });
			} catch {
				// best-effort cleanup
			}
		}
		// Failures stay in the queue with a retry action instead of toasting.
		if (!signal.aborted) {
			statuses.set(song.id, { phase: "error", song });
			console.error("[downloads] download failed:", error);
		} else {
			statuses.delete(song.id);
		}
		return false;
	} finally {
		disposeStream?.();
		await reader?.cancel().catch(() => undefined);
		reader?.releaseLock();
		// Clear the running slot *before* publishing. Emitting inside the
		// try/catch still included `current`, so a finished single song stayed
		// in the queue until some unrelated change re-rendered it (playlist
		// items were masked by `settle`'s job update emit).
		current = null;
		finishTransfer();
		emit();
	}
}

function enqueue(items: QueueItem[]): number {
	let added = 0;
	for (const item of items) {
		if (isBusy(item.song.id)) continue;
		statuses.set(item.song.id, { phase: "queued", song: item.song });
		queue.push(item);
		added += 1;
	}
	if (added > 0) {
		emit();
		void pump();
	}
	return added;
}

export function downloadSong(song: Song) {
	if (!isTauri()) return;
	enqueue([{ song }]);
}

/**
 * Saves a playlist (or album): uses the supplied track list when the caller
 * already has one, otherwise loads it. The menu shows aggregate progress
 * through the `jobs` map while this runs.
 */
function downloadPlaylist(playlistId: string, title: string, songs?: Song[]) {
	const id = canonicalPlaylistId(playlistId);
	if (!isTauri() || jobs.has(id)) return;
	jobs.set(id, { done: 0, failed: 0, title, total: 0 });
	emit();
	void (async () => {
		try {
			const list = songs?.length ? songs : (await loadPlaylistView(id))?.songs;
			if (!list) throw new Error("Could not load playlist");
			if (list.length === 0) {
				jobs.delete(id);
				emit();
				showToast("Playlist is empty");
				return;
			}
			const job = jobs.get(id);
			if (!job) return;
			jobs.set(id, { ...job, total: list.length });
			const added = enqueue(list.map((song) => ({ jobId: id, song })));
			if (added === 0) {
				finishJob(id);
			} else {
				// Songs already stored or queued elsewhere count toward the job.
				jobs.set(id, { ...job, total: list.length, done: list.length - added });
				emit();
			}
		} catch (error) {
			jobs.delete(id);
			emit();
			console.error("[downloads] playlist load failed:", error);
			showToast("Could not load playlist");
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
 * off stops future syncing but keeps the already-saved files.
 */
export function togglePlaylistDownload(
	id: string,
	title: string,
	songs?: Song[],
) {
	if (!isTauri()) return;
	const { downloadedPlaylists } = getSettings();
	if (isPlaylistDownloaded(id, downloadedPlaylists)) {
		unsubscribeDownloadedPlaylist(id);
		return;
	}
	updateSettings({
		downloadedPlaylists: [...downloadedPlaylists, canonicalPlaylistId(id)],
	});
	downloadPlaylist(id, title, songs);
}

/**
 * Queues anything missing from a subscribed playlist; a no-op for playlists
 * that are not kept downloaded or that are already complete, so it can run on
 * every visit without flickering the queue.
 *
 * Songs that already have a status in this session are skipped too: a failed
 * download should not be re-enqueued on every visit (the queue offers an
 * explicit retry instead), which previously re-fetched whole playlists.
 */
export async function syncDownloadedPlaylist(
	id: string,
	title: string,
	songs: Song[],
) {
	if (!isTauri() || songs.length === 0 || !isPlaylistDownloaded(id)) return;
	if (!(await hydrateDownloads()) || !isPlaylistDownloaded(id)) return;
	const missing = songs.filter(
		(song) => !entries.has(song.id) && !statuses.has(song.id),
	);
	if (missing.length) downloadPlaylist(id, title, missing);
}

/** Drops a deleted playlist's subscription (its files stay until removed). */
export function unsubscribeDownloadedPlaylist(id: string) {
	const { downloadedPlaylists } = getSettings();
	const remaining = downloadedPlaylists.filter(
		(playlist) => !isSamePlaylist(id, playlist),
	);
	if (remaining.length !== downloadedPlaylists.length)
		updateSettings({ downloadedPlaylists: remaining });
}

export function cancelDownload(id: string) {
	if (current?.song.id === id) {
		current.cancel();
		return;
	}
	const cancelled = queue.filter((item) => item.song.id === id);
	if (cancelled.length === 0) return;
	queue = queue.filter((item) => item.song.id !== id);
	statuses.delete(id);
	emit();
	for (const item of cancelled) settle(item, false);
}

export async function removeDownloads(ids: string[]) {
	if (ids.length === 0) return;
	const transfer =
		current && ids.includes(current.song.id) ? current.settled : null;
	for (const id of ids) cancelDownload(id);
	try {
		await hydrateDownloads();
		if (transfer) await transfer;
		const failed = await invoke<string[]>("downloads_remove", { ids });
		const failedIds = new Set(failed);
		const next = new Map(entries);
		// Entries whose file could not be deleted stay listed.
		for (const id of ids) {
			if (!failedIds.has(id)) next.delete(id);
		}
		entries = next;
		emit();
		if (failed.length > 0) {
			showToast(
				failed.length === 1
					? "Download is in use and was not removed"
					: "Some downloads are in use and were not removed",
			);
		} else {
			showToast(ids.length === 1 ? "Download removed" : "Downloads removed");
		}
	} catch (error) {
		console.error("[downloads] removal failed:", error);
		showToast("Could not remove downloads");
	}
}
