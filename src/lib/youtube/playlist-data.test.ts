import { expect, spyOn, test } from "bun:test";
import { YTNodes } from "youtubei.js/web";
import type { PlaylistTrack } from "../music/playlist";
import * as playlistApi from "./playlist-api";
import { createPlaylistPageMerge, loadPlaylistView } from "./playlist-data";

function track(id: string, entryId?: string): PlaylistTrack {
	return { id, entryId, artist: "Artist", title: id, thumbnail: "" };
}

function page(ids: string[], hasContinuation: boolean) {
	return {
		items: ids.map(
			(videoId) =>
				new YTNodes.MusicResponsiveListItem({
					navigationEndpoint: { watchEndpoint: { videoId } },
					flexColumns: [
						{
							musicResponsiveListItemFlexColumnRenderer: {
								text: { runs: [{ text: videoId }] },
							},
						},
					],
				}),
		),
		has_continuation: hasContinuation,
	} as unknown as playlistApi.Playlist;
}

test("refresh adds and removes tracks while later playlist pages are pending", async () => {
	const first = "first000001";
	const later = "later000001";
	const removedFirst = "removed0001";
	const removedLater = "removed0002";
	const removedTail = "removed0003";
	const addedFirst = "added000001";
	const addedLater = "added000002";
	const merge = createPlaylistPageMerge(
		[removedFirst, first, removedLater, later, removedTail].map((id) =>
			track(id),
		),
	);
	const secondPage = Promise.withResolvers<playlistApi.Playlist>();
	const finalPage = Promise.withResolvers<playlistApi.Playlist>();
	const firstPublished = Promise.withResolvers<void>();
	const secondPublished = Promise.withResolvers<void>();
	const getPlaylist = spyOn(playlistApi, "getPlaylist").mockResolvedValue(
		page([addedFirst, first], true),
	);
	const getContinuation = spyOn(playlistApi, "loadPlaylistContinuation")
		.mockReturnValueOnce(secondPage.promise)
		.mockReturnValueOnce(finalPage.promise);
	const visible = () => merge.snapshot(false).map(({ id }) => id);
	const loading = loadPlaylistView("PLprogressive", {
		onFirstPage(firstPage) {
			merge.append(firstPage.songs);
			firstPublished.resolve();
		},
		onContinuation(batch) {
			merge.append(batch);
			secondPublished.resolve();
		},
	});
	try {
		await Promise.race([firstPublished.promise, loading]);
		expect(visible()).toEqual([
			addedFirst,
			first,
			removedLater,
			later,
			removedTail,
		]);

		secondPage.resolve(page([addedLater, later], true));
		await Promise.race([secondPublished.promise, loading]);
		expect(visible()).toEqual([
			addedFirst,
			first,
			addedLater,
			later,
			removedTail,
		]);

		finalPage.resolve(page([], false));
		expect((await loading)?.complete).toBe(true);
		expect(merge.snapshot(true).map(({ id }) => id)).toEqual([
			addedFirst,
			first,
			addedLater,
			later,
		]);
	} finally {
		secondPage.resolve(page([], false));
		finalPage.resolve(page([], false));
		await loading.catch(() => undefined);
		getContinuation.mockRestore();
		getPlaylist.mockRestore();
	}
});

test("a page merge matches playlist occurrences individually across pages", () => {
	const first = track("repeated", "first");
	const second = track("repeated", "second");
	const added = track("repeated", "added");
	const legacy = track("legacy");

	const merge = createPlaylistPageMerge([first, legacy, second, legacy]);
	merge.append([added, { ...first }, { ...legacy }]);
	const merged = merge.snapshot(false);
	expect(merged).toEqual([added, first, legacy, second, legacy]);
	expect(merged[1]).toBe(first);
	merge.append([{ ...legacy }]);
	expect(merge.snapshot(false)).toEqual([added, first, legacy, legacy]);
});

test("a later legacy duplicate does not bring back an earlier removed occurrence", () => {
	const duplicate = track("duplicate");
	const firstAnchor = track("firstAnchor");
	const secondAnchor = track("secondAnchor");
	const tail = track("tail");
	const merge = createPlaylistPageMerge([
		duplicate,
		duplicate,
		firstAnchor,
		duplicate,
		secondAnchor,
		tail,
	]);
	merge.append([duplicate, firstAnchor]);
	expect(merge.snapshot(false)).toEqual([
		duplicate,
		firstAnchor,
		duplicate,
		secondAnchor,
		tail,
	]);
	merge.append([duplicate, secondAnchor]);
	expect(merge.snapshot(false)).toEqual([
		duplicate,
		firstAnchor,
		duplicate,
		secondAnchor,
		tail,
	]);
});

test("pages with no overlap or reordered tracks retain the unresolved rows", () => {
	const added = track("added");
	const first = track("first");
	const second = track("second");
	const third = track("third");
	const merge = createPlaylistPageMerge([first, second, third]);
	merge.append([added]);
	expect(merge.snapshot(false)).toEqual([added, first, second, third]);
	merge.append([third, first]);
	expect(merge.snapshot(false)).toEqual([added, third, first, second]);
	expect(merge.snapshot(true)).toEqual([added, third, first]);
});
