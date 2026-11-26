import { expect, mock, test } from "bun:test";
import { type Actions, Parser, YTNodes } from "youtubei.js/web";
import {
	type ArtistShelfItem,
	loadArtistCategoryItems,
} from "./artist-category";

const artistId = "UCqECaJ8Gagnn7YCbPEzWH6g";
const category = new YTNodes.NavigationEndpoint({
	browseEndpoint: { browseId: artistId, params: "category-params" },
});

function track(id: string, title: string) {
	return {
		musicResponsiveListItemRenderer: {
			navigationEndpoint: { watchEndpoint: { videoId: id } },
			flexColumns: [
				{
					musicResponsiveListItemFlexColumnRenderer: {
						text: { runs: [{ text: title }] },
					},
				},
			],
		},
	};
}

test("artist categories publish the first page before their continuation and dedupe songs in order", async () => {
	const first = Parser.parseResponse({
		contents: {
			sectionListRenderer: {
				contents: [
					{
						musicPlaylistShelfRenderer: {
							contents: [
								track("ABCDEFGHIJK", "First song"),
								{
									continuationItemRenderer: {
										continuationEndpoint: {
											continuationCommand: {
												request: "CONTINUATION_REQUEST_TYPE_BROWSE",
												token: "next-page",
											},
										},
									},
								},
							],
						},
					},
				],
			},
		},
	});
	const next = Parser.parseResponse({
		onResponseReceivedActions: [
			{
				appendContinuationItemsAction: {
					continuationItems: [
						track("ABCDEFGHIJK", "Duplicate song"),
						track("LMNOPQRSTUV", "Second song"),
					],
				},
			},
		],
	});
	const continuation = Promise.withResolvers<typeof next>();
	const firstDelivered = Promise.withResolvers<void>();
	const batches: Array<{ titles: string[]; hasMore: boolean }> = [];
	const execute = mock(async () => first)
		.mockResolvedValueOnce(first)
		.mockReturnValueOnce(continuation.promise);
	const loading = loadArtistCategoryItems(
		{ execute } as unknown as Actions,
		category,
		"Artist",
		artistId,
		new AbortController().signal,
		(items: ArtistShelfItem[], hasMore) => {
			batches.push({ titles: items.map((item) => item.title), hasMore });
			firstDelivered.resolve();
		},
	);
	await firstDelivered.promise;
	expect(batches).toEqual([{ titles: ["First song"], hasMore: true }]);
	continuation.resolve(next);
	const items = await loading;

	expect(execute).toHaveBeenCalledTimes(2);
	expect(execute).toHaveBeenNthCalledWith(
		1,
		"browse",
		expect.objectContaining({ params: "category-params", client: "YTMUSIC" }),
	);
	expect(items.map((item) => item.song?.id)).toEqual([
		"ABCDEFGHIJK",
		"LMNOPQRSTUV",
	]);
	expect(batches.at(-1)).toEqual({ titles: ["Second song"], hasMore: false });
});

test("a selected category tab without content is a retryable error", async () => {
	const execute = mock(async () =>
		Parser.parseResponse({
			contents: {
				singleColumnBrowseResultsRenderer: {
					tabs: [{ tabRenderer: { title: "Music", selected: true } }],
				},
			},
		}),
	);

	await expect(
		loadArtistCategoryItems(
			{ execute } as unknown as Actions,
			category,
			"Artist",
			artistId,
			new AbortController().signal,
		),
	).rejects.toThrow("unloaded artist tab");
});
