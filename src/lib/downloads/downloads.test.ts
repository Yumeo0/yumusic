import { expect, mock, spyOn, test } from "bun:test";
import type { Song } from "../music/song";
import { getSettings, updateSettings } from "../stores/settings";
import * as playback from "../youtube/playback-stream";
import * as playlist from "../youtube/playlist-data";
import * as sabr from "../youtube/sabr-source";
import {
	cancelDownload,
	type DownloadEntry,
	downloadSong,
	getDownloadEntry,
	removeDownloads,
	stopPlaylistDownload,
	syncDownloadedPlaylist,
	togglePlaylistDownload,
} from "./downloads";

test("a playlist visit waits for the shared download index before deciding which songs are missing", async () => {
	const song = {
		id: "abcdefghijk",
		title: "Track",
		artist: "Artist",
		thumbnail: "",
	};
	const stored: DownloadEntry = {
		...song,
		thumbnail: null,
		description: null,
		duration: null,
		ext: "m4a",
		size: 40,
		path: "offline.m4a",
		downloadedAt: 1,
	};
	const commands: string[] = [];
	const index = Promise.withResolvers<DownloadEntry[]>();
	let settings = JSON.stringify({
		downloadedPlaylists: ["VLPLsaved", "PLcancelled"],
	});
	const window = Object.assign(new EventTarget(), {
		__TAURI_INTERNALS__: {
			invoke: (command: string) => {
				commands.push(command);
				return index.promise;
			},
		},
	});
	const globals = {
		isTauri: true,
		window,
		localStorage: {
			getItem: () => settings,
			setItem: (_key: string, value: string) => {
				settings = value;
			},
		},
	};
	const descriptors = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	try {
		let completed = false;
		const saved = Promise.resolve(
			syncDownloadedPlaylist("PLsaved", "Saved", [song]),
		).then(() => {
			completed = true;
		});
		const cancelled = syncDownloadedPlaylist("VLPLcancelled", "Cancel", [
			{ ...song, id: "lmnopqrstuv" },
		]);
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(commands).toEqual(["downloads_list"]);
		stopPlaylistDownload("VLPLcancelled");
		index.resolve([stored]);
		await Promise.all([saved, cancelled]);
		expect(getDownloadEntry(song.id)).toEqual(stored);
		expect(commands).toEqual(["downloads_list"]);
	} finally {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

function downloadFixture(
	parallelDownloads: number,
	waitForWrite?: (data: string) => Promise<void>,
) {
	let settings = JSON.stringify({ parallelDownloads });
	const streams = new Map<
		string,
		ReadableStreamDefaultController<Uint8Array>
	>();
	const transfers = new Map<string, { id: string; data: string }[]>();
	const commands = mock(
		async (
			command: string,
			args: { songId?: string; token?: string; data?: string; ids?: string[] },
		) => {
			switch (command) {
				case "downloads_list":
					return [];
				case "download_begin":
					if (!args.songId) throw new Error("Missing song");
					transfers.set(args.songId, []);
					return args.songId;
				case "download_append":
					if (!args.token || !args.data) throw new Error("Missing write");
					transfers.get(args.token)?.push({ id: args.token, data: args.data });
					await waitForWrite?.(args.data);
					return undefined;
				case "download_finish":
					return { id: args.token, path: `${args.token}.webm`, size: 1 };
				case "download_abort":
					return undefined;
				case "downloads_remove":
					return [];
				default:
					throw new Error(`Unexpected command ${command}`);
			}
		},
	);
	const fakeWindow = Object.assign(new EventTarget(), {
		__TAURI_INTERNALS__: { invoke: commands },
		setTimeout: () => 1,
		clearTimeout: () => undefined,
	});
	const globals = {
		isTauri: true,
		window: fakeWindow,
		localStorage: {
			getItem: (key: string) =>
				key === "yumusic:settings:v1" ? settings : null,
			setItem: (_: string, value: string) => {
				settings = value;
			},
		},
	};
	const descriptors = Object.keys(globals).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, value });
	const prepared = spyOn(playback, "getPlaybackStream").mockImplementation(
		async (id) =>
			({ videoId: id, videoInfo: { basic_info: {} } }) as Awaited<
				ReturnType<typeof playback.getPlaybackStream>
			>,
	);
	const source = spyOn(sabr, "createSabrAudioSource").mockImplementation(
		async (id) => {
			if (!id) throw new Error("Missing video ID");
			return () => ({
				audio: new ReadableStream<Uint8Array>({
					start: (controller) => {
						streams.set(id, controller);
					},
					cancel: () => {
						streams.delete(id);
					},
				}),
				mime: "audio/webm",
				contentLength: 1,
				dispose: () => undefined,
			});
		},
	);
	return {
		commands,
		prepared,
		streams,
		transfers,
		source,
		restore: () => {
			prepared.mockRestore();
			source.mockRestore();
			for (const [key, descriptor] of descriptors) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		},
	};
}

function track(id: string): Song {
	return { id, title: id, artist: "Artist", thumbnail: "" };
}

async function until(condition: () => boolean) {
	for (let attempt = 0; !condition(); attempt++) {
		if (attempt === 100)
			throw new Error("Downloader did not reach the expected state");
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
}

test("runs one preparation ahead and applies parallelism changes to queued transfers", async () => {
	const fixture = downloadFixture(1);
	const ids = ["parallel001", "parallel002", "parallel003", "parallel004"];
	const [first, second, third, fourth] = ids;
	try {
		for (const id of ids) downloadSong(track(id));
		await until(
			() =>
				fixture.streams.has(first) && fixture.prepared.mock.calls.length === 2,
		);
		expect([...fixture.streams.keys()]).toEqual([first]);
		expect(fixture.prepared.mock.calls.map(([id]) => id)).toEqual([
			first,
			second,
		]);
		expect(fixture.source.mock.calls[0]?.[4]).toMatchObject({
			downloadQuality: "original",
		});

		updateSettings({ parallelDownloads: 3, downloadQuality: "low" });
		await until(
			() =>
				fixture.streams.has(third) && fixture.prepared.mock.calls.length === 4,
		);
		expect([...fixture.streams.keys()]).toEqual([first, second, third]);
		expect(
			fixture.source.mock.calls
				.slice(1)
				.map((call) => call[4]?.downloadQuality),
		).toEqual(["low", "low"]);

		updateSettings({ parallelDownloads: 1 });
		fixture.streams.get(second)?.close();
		fixture.streams.get(third)?.close();
		await until(() => !!getDownloadEntry(second) && !!getDownloadEntry(third));
		expect(fixture.streams.has(fourth)).toBe(false);

		cancelDownload(first);
		await until(() => fixture.streams.has(fourth));
		fixture.streams.get(fourth)?.close();
		await until(() => !!getDownloadEntry(fourth));
		expect(getDownloadEntry(first)).toBeUndefined();
	} finally {
		for (const id of ids) cancelDownload(id);
		fixture.restore();
	}
});

test("downloads from the first playlist page and deduplicates tracks shared across jobs", async () => {
	const fixture = downloadFixture(2);
	const [first, second, shared] = [
		"discovery01",
		"discovery02",
		"discovery03",
	].map(track);
	const continuation = Promise.withResolvers<void>();
	const page = {
		title: "Playlist",
		subtitle: "",
		thumbnail: null,
		editable: false,
		songs: [first, shared],
		complete: false,
	};
	const load = spyOn(playlist, "loadPlaylistView").mockImplementation(
		async (_id, options) => {
			options?.onFirstPage?.(page);
			await continuation.promise;
			options?.onContinuation?.([shared, second]);
			return {
				...page,
				songs: [first, shared, shared, second],
				complete: true,
			};
		},
	);
	try {
		togglePlaylistDownload("PLfirst-page", "First");
		togglePlaylistDownload("PLshared-track", "Shared", [shared]);
		await until(
			() => fixture.streams.has(first.id) && fixture.streams.has(shared.id),
		);
		expect(fixture.prepared.mock.calls.map(([id]) => id)).toEqual([
			first.id,
			shared.id,
		]);

		continuation.resolve();
		await until(() => fixture.prepared.mock.calls.length === 3);
		fixture.streams.get(first.id)?.close();
		await until(() => fixture.streams.has(second.id));
		fixture.streams.get(shared.id)?.close();
		fixture.streams.get(second.id)?.close();
		await until(() =>
			[first, second, shared].every((song) => getDownloadEntry(song.id)),
		);
		expect([...fixture.transfers.keys()]).toEqual([
			first.id,
			shared.id,
			second.id,
		]);
		expect(load).toHaveBeenCalledTimes(1);
	} finally {
		continuation.resolve();
		for (const song of [first, second, shared]) cancelDownload(song.id);
		load.mockRestore();
		fixture.restore();
	}
});

test("stopping a playlist drops its pages and exclusive work while keeping shared and saved tracks", async () => {
	const fixture = downloadFixture(3);
	const [saved, exclusive, shared, standalone, queued, waiting, late] = [
		"stopSaved01",
		"stopActive1",
		"stopShared1",
		"stopSingle1",
		"stopQueued1",
		"stopQueued2",
		"stopLate001",
	].map(track);
	const continuation = Promise.withResolvers<void>();
	const page = {
		title: "Playlist",
		subtitle: "",
		thumbnail: null,
		editable: false,
		songs: [saved, exclusive, shared, standalone, queued, waiting],
		complete: false,
	};
	const load = spyOn(playlist, "loadPlaylistView").mockImplementation(
		async (_id, options) => {
			options?.onFirstPage?.(page);
			await continuation.promise;
			options?.onContinuation?.([late]);
			return { ...page, songs: [...page.songs, late], complete: true };
		},
	);
	try {
		togglePlaylistDownload("PLstop", "Playlist");
		await until(() => fixture.transfers.has(shared.id));
		updateSettings({ downloadedPlaylists: ["PLstop", "PLshared"] });
		await syncDownloadedPlaylist("PLshared", "Shared playlist", [shared]);
		downloadSong(standalone);
		fixture.streams.get(saved.id)?.close();
		await until(() => fixture.transfers.has(standalone.id));
		await until(() =>
			fixture.prepared.mock.calls.some(([id]) => id === queued.id),
		);

		stopPlaylistDownload("VLPLstop");
		expect(load.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(getSettings().downloadedPlaylists).toEqual(["PLshared"]);
		continuation.resolve();
		await syncDownloadedPlaylist("PLstop", "Playlist", [late, queued]);
		await until(() =>
			fixture.commands.mock.calls.some(
				([name, args]) =>
					name === "download_abort" && args.token === exclusive.id,
			),
		);

		expect(fixture.prepared.mock.calls.map(([id]) => id)).not.toContain(
			late.id,
		);
		expect(fixture.prepared.mock.calls.map(([id]) => id)).not.toContain(
			waiting.id,
		);
		expect(fixture.transfers.has(queued.id)).toBe(false);
		expect(getDownloadEntry(saved.id)).toBeDefined();
		expect(getDownloadEntry(exclusive.id)).toBeUndefined();
		fixture.streams.get(shared.id)?.close();
		fixture.streams.get(standalone.id)?.close();
		await until(
			() => !!getDownloadEntry(shared.id) && !!getDownloadEntry(standalone.id),
		);
	} finally {
		continuation.resolve();
		for (const song of [...page.songs, late]) cancelDownload(song.id);
		load.mockRestore();
		fixture.restore();
	}
});

test("a restarted playlist waits for the cancelled transfer to clean up before retrying", async () => {
	const write = Promise.withResolvers<void>();
	const fixture = downloadFixture(2, () => write.promise);
	const song = track("stopRetry01");
	const begins = () =>
		fixture.commands.mock.calls.filter(([name]) => name === "download_begin")
			.length;
	try {
		togglePlaylistDownload("PLstop-retry", "Retry", [song]);
		await until(() => fixture.transfers.has(song.id));
		fixture.streams.get(song.id)?.enqueue(new Uint8Array(512 * 1024));
		await until(() => fixture.transfers.get(song.id)?.length === 1);

		stopPlaylistDownload("PLstop-retry");
		togglePlaylistDownload("PLstop-retry", "Retry", [song]);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(begins()).toBe(1);
		write.resolve();
		await until(() => begins() === 2);
		fixture.streams.get(song.id)?.close();
		await until(() => !!getDownloadEntry(song.id));
		expect(
			fixture.commands.mock.calls
				.map(([name]) => name)
				.filter((name) => name !== "downloads_list"),
		).toEqual([
			"download_begin",
			"download_append",
			"download_abort",
			"download_begin",
			"download_finish",
		]);
	} finally {
		write.resolve();
		cancelDownload(song.id);
		fixture.restore();
	}
});

test("removal cancels and waits for both active files before deleting them", async () => {
	const writes = Promise.withResolvers<void>();
	const fixture = downloadFixture(2, () => writes.promise);
	const ids = ["remove00001", "remove00002"];
	let removal: Promise<void> | undefined;
	try {
		for (const id of ids) downloadSong(track(id));
		await until(() => ids.every((id) => fixture.transfers.has(id)));
		for (const id of ids)
			fixture.streams.get(id)?.enqueue(new Uint8Array(512 * 1024));
		await until(() =>
			ids.every((id) => fixture.transfers.get(id)?.length === 1),
		);
		removal = removeDownloads(ids);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(
			fixture.commands.mock.calls.some(([name]) => name === "downloads_remove"),
		).toBe(false);
		writes.resolve();
		await removal;
		const relevant = fixture.commands.mock.calls.filter(
			([name]) => name === "download_abort" || name === "downloads_remove",
		);
		expect(
			relevant
				.slice(0, 2)
				.map(([_, args]) => args.token)
				.sort(),
		).toEqual(ids);
		expect(relevant[2]).toEqual(["downloads_remove", { ids }]);
		expect(ids.some((id) => getDownloadEntry(id))).toBe(false);
	} finally {
		writes.resolve();
		await removal;
		for (const id of ids) cancelDownload(id);
		fixture.restore();
	}
});

test("reads ahead during a file write and commits the batches in order", async () => {
	const firstWrite = Promise.withResolvers<void>();
	let pending = true;
	const fixture = downloadFixture(1, async () => {
		if (pending) {
			pending = false;
			await firstWrite.promise;
		}
	});
	const song = track("pipeline001");
	const first = new Uint8Array(512 * 1024).fill(1);
	const second = new Uint8Array(512 * 1024).fill(2);
	try {
		downloadSong(song);
		await until(() => fixture.transfers.has(song.id));
		const reader = fixture.streams.get(song.id);
		expect(reader).toBeDefined();
		reader?.enqueue(first);
		await until(() => !pending);
		reader?.enqueue(second);
		await until(() => reader?.desiredSize === 1);
		reader?.close();
		expect(fixture.transfers.get(song.id)).toHaveLength(1);
		expect(getDownloadEntry(song.id)).toBeUndefined();
		firstWrite.resolve();
		await until(() => !!getDownloadEntry(song.id));
		expect(
			fixture.transfers
				.get(song.id)
				?.map(({ data }) => atob(data).charCodeAt(0)),
		).toEqual([1, 2]);
	} finally {
		firstWrite.resolve();
		cancelDownload(song.id);
		fixture.restore();
	}
});
