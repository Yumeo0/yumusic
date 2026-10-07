import { invoke, isTauri } from "@tauri-apps/api/core";
import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
import { useSyncExternalStore } from "react";
import { Constants } from "youtubei.js";
import type { Song } from "@/contexts/player-context";
import {
	getSettings,
	updateSettings,
	useSettings,
} from "@/lib/stores/settings";
import { showToast } from "@/lib/stores/toast";
import { botguardService } from "@/lib/youtube/botguard-service";
import { loadPlaylistSongs } from "@/lib/youtube/playlist-data";
import { fetchFunction, getSongStream } from "@/lib/youtube/youtube-client";

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

export interface PlaylistDownloadJob {
	title: string;
	total: number;
	done: number;
	failed: number;
}

/** One row of the download queue: the running track or anything waiting. */
export interface DownloadTask {
	song: Song;
	phase: "downloading" | "queued";
	progress: number | null;
}

export interface DownloadsSnapshot {
	entries: Map<string, DownloadEntry>;
	statuses: Map<string, DownloadStatus>;
	/** Playlist/album downloads in progress, keyed by collection id. */
	jobs: Map<string, PlaylistDownloadJob>;
	/** Running + queued downloads in order (running first). */
	tasks: DownloadTask[];
	/** Songs whose download failed; retry or dismiss them from the queue. */
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

		// Queue order: the running track first, then the waiting ones.
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
			entries: new Map(entries),
			failed,
			jobs: new Map(jobs),
			statuses: new Map(statuses),
			tasks,
			totalBytes,
		};
	}
	return snapshot;
}

/** Reactive view of the downloads; re-renders subscribers on any change. */
export function useDownloads(): DownloadsSnapshot {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The stored download for a song, when it is saved on this device. */
export function getDownloadEntry(id: string): DownloadEntry | undefined {
	return entries.get(id);
}

/** Loads the stored index once at startup. */
let hydratePromise: Promise<void> | null = null;
/** True once the stored index has been read; keeps sync from racing startup. */
let hydrated = false;
export function hydrateDownloads(): Promise<void> {
	if (hydratePromise) return hydratePromise;
	hydratePromise = (async () => {
		if (!isTauri()) return;
		try {
			const stored = await invoke<DownloadEntry[]>("downloads_list");
			entries = new Map(stored.map((entry) => [entry.id, entry]));
			hydrated = true;
			emit();
		} catch (error) {
			hydratePromise = null;
			console.warn("[downloads] could not load the index:", error);
		}
	})();
	return hydratePromise;
}

/* ── Queue and runner ──────────────────────────────────────────── */

interface QueueItem {
	song: Song;
	/** Playlist/album job this song belongs to, for aggregate progress. */
	jobId?: string;
}

let queue: QueueItem[] = [];
let current: {
	song: Song;
	jobId?: string;
	cancel: () => void;
} | null = null;
let pumping = false;

/** Re-downloading a stored song is a no-op; anything in flight is skipped too. */
function isBusy(id: string): boolean {
	const status = statuses.get(id);
	return (
		entries.has(id) ||
		(status !== undefined && status.phase !== "error") ||
		current?.song.id === id ||
		queue.some((item) => item.song.id === id)
	);
}

function settle(item: QueueItem, ok: boolean) {
	if (!item.jobId) return;
	const job = jobs.get(item.jobId);
	if (!job) return;
	job.done += 1;
	if (!ok) job.failed += 1;
	if (job.done >= job.total) finishJob(item.jobId);
	emit();
}

function finishJob(jobId: string) {
	jobs.delete(jobId);
	emit();
}

/** Clears a failed download from the queue without retrying it. */
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
	let cancelled = false;
	current = { cancel: () => (cancelled = true), jobId: item.jobId, song };
	statuses.set(song.id, { phase: "downloading", progress: null, song });
	emit();

	let stream: SabrStream | null = null;
	let token: string | null = null;
	let lastProgressEmit = 0;
	try {
		const result = await getSongStream(song.id);
		if (cancelled) throw new Error("cancelled");
		// Hydration may have filled the index while this sat in the queue:
		// the file is already stored, so re-downloading it is wasted work.
		if (entries.has(song.id)) {
			statuses.delete(song.id);
			emit();
			return true;
		}
		const videoInfo = result.videoInfo;
		const streamingData = videoInfo.streaming_data;
		if (!streamingData) throw new Error("streaming data is missing");
		const decipher = async (url?: string) =>
			(await result.innertube.session.player?.decipher(url)) as string;
		const client = result.innertube.session.context.client;
		const ustreamerConfig =
			videoInfo.player_config?.media_common_config
				.media_ustreamer_request_config?.video_playback_ustreamer_config;
		const clientInfo = {
			osName: client.osName,
			osVersion: client.osVersion,
			clientName: parseInt(
				Constants.CLIENT_NAME_IDS[
					client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
				],
				10,
			),
			clientVersion: client.clientVersion,
		};

		stream = new SabrStream({
			videoId: song.id,
			fetchFunction: fetchFunction as unknown as typeof fetch,
			serverAbrStreamingUrl: await decipher(
				streamingData.server_abr_streaming_url,
			),
			videoPlaybackUstreamerConfig: ustreamerConfig ?? "",
			clientInfo,
			poToken: await botguardService.mintToken(song.id),
			formats: streamingData.adaptive_formats.map(buildSabrFormat),
		});
		if (cancelled) throw new Error("cancelled");

		const { audioStream, selectedFormats } = stream.start({
			enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
			audioPreferences: {},
			isPostLiveDvr: false,
		});
		if (cancelled) throw new Error("cancelled");

		const mime = selectedFormats.audioFormat?.mimeType ?? "";
		// Both containers are detected from their magic bytes by the asset
		// protocol, and `.mp4` also has a safe MIME fallback if not.
		const ext = mime.includes("webm")
			? "webm"
			: mime.includes("mp4")
				? "mp4"
				: "bin";
		const totalBytes = selectedFormats.audioFormat?.contentLength ?? 0;

		token = await invoke<string>("download_begin", { songId: song.id, ext });
		if (cancelled) throw new Error("cancelled");

		const reader =
			audioStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
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

		while (!cancelled) {
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
		if (cancelled) throw new Error("cancelled");
		await flush();

		const entry = await invoke<DownloadEntry>("download_finish", {
			metadata: {
				artist: song.artist,
				duration: song.duration ?? null,
				ext,
				id: song.id,
				thumbnail: song.thumbnail || null,
				title: song.title,
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
		stream?.abort();
		// Failures stay in the queue with a retry action instead of toasting.
		if (!cancelled) {
			statuses.set(song.id, { phase: "error", song });
			console.error("[downloads] download failed:", error);
		} else {
			statuses.delete(song.id);
		}
		return false;
	} finally {
		// Clear the running slot *before* publishing. Emitting inside the
		// try/catch still included `current`, so a finished single song stayed
		// in the queue until some unrelated change re-rendered it (playlist
		// items were masked by `settle`'s job update emit).
		current = null;
		emit();
	}
}

/** Queues songs unless they are stored or already in flight. */
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

/** Saves one song for offline playback. */
export function downloadSong(song: Song) {
	if (!isTauri()) return;
	enqueue([{ song }]);
}

/** Saves every given song that is not stored yet. */
export function downloadSongs(songs: Song[]) {
	if (!isTauri()) return;
	enqueue(songs.map((song) => ({ song })));
}

/**
 * Saves a playlist (or album): uses the supplied track list when the caller
 * already has one, otherwise loads it. The menu shows aggregate progress
 * through the `jobs` map while this runs.
 */
export function downloadPlaylist(id: string, title: string, songs?: Song[]) {
	if (!isTauri() || jobs.has(id)) return;
	jobs.set(id, { done: 0, failed: 0, title, total: 0 });
	emit();
	void (async () => {
		try {
			const list =
				songs && songs.length > 0 ? songs : await loadPlaylistSongs(id);
			if (list.length === 0) {
				jobs.delete(id);
				emit();
				showToast("Playlist is empty");
				return;
			}
			const job = jobs.get(id);
			if (!job) return;
			job.total = list.length;
			const added = enqueue(list.map((song) => ({ jobId: id, song })));
			// Songs that were already stored count as done right away.
			job.done = list.length - added;
			if (added === 0) finishJob(id);
			else emit();
		} catch (error) {
			jobs.delete(id);
			emit();
			console.error("[downloads] playlist load failed:", error);
			showToast("Could not load playlist");
		}
	})();
}

/** Whether the playlist is kept downloaded (the toggle's on state). */
export function isPlaylistDownloaded(id: string): boolean {
	return getSettings().downloadedPlaylists.includes(id);
}

/** Reactive version of `isPlaylistDownloaded` for menus and buttons. */
export function usePlaylistDownloaded(id: string): boolean {
	const [settings] = useSettings();
	return settings.downloadedPlaylists.includes(id);
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
	if (downloadedPlaylists.includes(id)) {
		updateSettings({
			downloadedPlaylists: downloadedPlaylists.filter(
				(playlistId) => playlistId !== id,
			),
		});
		return;
	}
	updateSettings({ downloadedPlaylists: [...downloadedPlaylists, id] });
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
export function syncDownloadedPlaylist(
	id: string,
	title: string,
	songs: Song[],
) {
	// Before the stored index is read, every song would look missing and the
	// whole playlist would be re-downloaded. Wait for the next visit instead.
	if (!hydrated || songs.length === 0 || !isPlaylistDownloaded(id)) return;
	const missing = songs.some(
		(song) => !entries.has(song.id) && !statuses.has(song.id),
	);
	if (!missing) return;
	downloadPlaylist(id, title, songs);
}

/** Drops a deleted playlist's subscription (its files stay until removed). */
export function unsubscribeDownloadedPlaylist(id: string) {
	const { downloadedPlaylists } = getSettings();
	if (!downloadedPlaylists.includes(id)) return;
	updateSettings({
		downloadedPlaylists: downloadedPlaylists.filter(
			(playlistId) => playlistId !== id,
		),
	});
}

/** Cancels a queued or running download. */
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

/** Removes downloads from disk and the index. */
export async function removeDownloads(ids: string[]) {
	if (ids.length === 0) return;
	for (const id of ids) cancelDownload(id);
	try {
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

/** Base64 for the IPC transport; the Rust side decodes and appends. */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
