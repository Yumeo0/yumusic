import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { PlaylistView } from "../music/playlist";
import * as youtubeSession from "../youtube/client-session";
import * as playlistApi from "../youtube/playlist-api";
import { loadPlaylistLibrary } from "../youtube/playlist-library";
import { removePlaylistTrack } from "../youtube/playlist-mutations";
import {
	addSongToCachedPlaylist,
	LIBRARY_CACHE_KEY,
	PLAYLIST_CACHE_PREFIX,
	type PlaylistChange,
	patchCachedPlaylistMetadata,
	readCache,
	readLibraryCache,
	readPlaylistView,
	removeSongFromCachedPlaylist,
	subscribeToLibraryChanges,
	subscribeToPlaylistChanges,
	writeCache,
	writeLibraryCache,
	writePlaylistView,
} from "./playlist-cache";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
const values = new Map<string, string>();
beforeEach(() => {
	values.clear();
	for (const name of ["window", "localStorage"])
		descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: new EventTarget(),
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
			removeItem: (key: string) => {
				values.delete(key);
			},
		},
	});
});
afterEach(() => {
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

const song = {
	id: "abcdefghijk",
	title: "Track",
	artist: "Artist",
	thumbnail: "",
};
const view: PlaylistView = {
	id: "PLtest",
	title: "Old name",
	thumbnail: "old-cover",
	subtitle: "Playlist",
	songs: [song],
	complete: true,
	editable: true,
};

test("confirmed edits update library and detail aliases before notifying open views", () => {
	writeCache(LIBRARY_CACHE_KEY, [
		{ id: "VLPLtest", title: view.title, thumbnail: view.thumbnail },
		{ id: "other", title: "Untouched" },
	]);
	writeCache(`${PLAYLIST_CACHE_PREFIX}PLtest`, view);
	writeCache(`${PLAYLIST_CACHE_PREFIX}VLPLtest`, { ...view, id: "VLPLtest" });
	let visibleTitle = "Old name";
	const stop = subscribeToLibraryChanges(() => {
		visibleTitle =
			readCache<Array<{ title: string }>>(LIBRARY_CACHE_KEY)?.data[0].title ??
			"";
	});
	const changes: PlaylistChange[] = [];
	const stopDetails = subscribeToPlaylistChanges("PLtest", (change) => {
		changes.push(change);
	});
	patchCachedPlaylistMetadata("VLPLtest", {
		title: "New name",
		thumbnail: "new-cover",
	});
	expect(visibleTitle).toBe("New name");
	for (const id of ["PLtest", "VLPLtest"])
		expect(readPlaylistView(id)?.data).toMatchObject({
			title: "New name",
			thumbnail: "new-cover",
			songs: [song],
		});
	expect(
		readCache<Array<{ title: string }>>(LIBRARY_CACHE_KEY)?.data[1].title,
	).toBe("Untouched");
	expect(changes).toHaveLength(1);
	stop();
	stopDetails();
});

test("adding from a different view notifies the open playlist and retains deliberate duplicate entries", () => {
	writeCache(`${PLAYLIST_CACHE_PREFIX}VLPLtest`, view);
	let visible = [...view.songs];
	const stop = subscribeToPlaylistChanges("VLPLtest", (change) => {
		if (change.type === "add") visible = [change.song, ...visible];
	});
	addSongToCachedPlaylist("PLtest", song);
	expect(visible).toHaveLength(2);
	expect(readPlaylistView("VLPLtest")?.data.songs).toHaveLength(2);
	stop();
});

test("uncached playlists still notify mounted views without changing other playlists", () => {
	let notifications = 0;
	const stop = subscribeToPlaylistChanges("PLtest", () => {
		notifications++;
	});
	addSongToCachedPlaylist("PLother", song);
	expect(notifications).toBe(0);
	addSongToCachedPlaylist("VLPLtest", song);
	expect(notifications).toBe(1);
	stop();
	addSongToCachedPlaylist("PLtest", song);
	expect(notifications).toBe(1);
	expect(readCache(`${PLAYLIST_CACHE_PREFIX}PLtest`)).toBeNull();
});

test("a completed library refresh preserves an edit confirmed while the request was running", async () => {
	const old = {
		id: "PLtest",
		title: "Old title",
		subtitle: "Playlist",
		thumbnail: null,
	};
	writeLibraryCache([old]);
	const response = Promise.withResolvers<(typeof old)[]>();
	const fetch = spyOn(playlistApi, "fetchLibraryPlaylists").mockReturnValue(
		response.promise,
	);
	try {
		const grid = loadPlaylistLibrary(true);
		const dialog = loadPlaylistLibrary(true);
		patchCachedPlaylistMetadata(old.id, {
			title: "New title",
			thumbnail: "new-cover",
		});
		response.resolve([old]);
		for (const pending of [grid, dialog]) {
			expect(await pending).toEqual([
				{ ...old, title: "New title", thumbnail: "new-cover" },
			]);
		}
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(readLibraryCache()?.data[0]?.title).toBe("New title");
	} finally {
		fetch.mockRestore();
	}
});

test("removal uses the selected entry's identity after another row shifts its index", () => {
	const earlier = { ...song, entryId: "earlier" };
	const selected = { ...song, entryId: "selected" };
	const later = { ...song, entryId: "later" };
	writePlaylistView("PLtest", { ...view, songs: [earlier, selected, later] });
	removeSongFromCachedPlaylist("PLtest", selected, 2);
	expect(readPlaylistView("VLPLtest")?.data.songs).toEqual([earlier, later]);
});

test("a refused remote removal leaves the cached track intact", async () => {
	const selected = { ...song, entryId: "selected" };
	writePlaylistView("PLtest", { ...view, songs: [selected] });
	let requestedId: unknown;
	const client = {
		actions: {
			async execute(
				_path: string,
				payload: { actions: { setVideoId: string }[] },
			) {
				requestedId = payload.actions[0]?.setVideoId;
				return {
					success: true,
					status_code: 200,
					data: { status: "STATUS_FAILED" },
				};
			},
		},
	} as unknown as Awaited<ReturnType<typeof youtubeSession.getYoutubeClient>>;
	const mock = spyOn(youtubeSession, "getYoutubeClient").mockResolvedValue(
		client,
	);
	try {
		await expect(removePlaylistTrack("PLtest", selected, 0)).rejects.toThrow(
			"Playlist edit failed",
		);
		expect(requestedId).toBe("selected");
		expect(readPlaylistView("PLtest")?.data.songs).toEqual([selected]);
	} finally {
		mock.mockRestore();
	}
});
