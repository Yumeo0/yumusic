import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	addSongToCachedPlaylist,
	LIBRARY_CACHE_KEY,
	PLAYLIST_CACHE_PREFIX,
	type PlaylistChange,
	type PlaylistView,
	patchCachedPlaylistMetadata,
	readCache,
	subscribeToLibraryChanges,
	subscribeToPlaylistChanges,
	writeCache,
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
		expect(
			readCache<PlaylistView>(PLAYLIST_CACHE_PREFIX + id)?.data,
		).toMatchObject({
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
	expect(
		readCache<PlaylistView>(`${PLAYLIST_CACHE_PREFIX}VLPLtest`)?.data.songs,
	).toHaveLength(2);
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
