import { expect, test } from "bun:test";
import {
	type DownloadEntry,
	getDownloadEntry,
	syncDownloadedPlaylist,
	unsubscribeDownloadedPlaylist,
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
		unsubscribeDownloadedPlaylist("VLPLcancelled");
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
