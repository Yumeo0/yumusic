import { expect, mock, test } from "bun:test";
import { type Actions, Parser, YTNodes } from "youtubei.js/web";
import { loadArtistCategoryItems } from "./artist-category";

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

test("expanded artist track lists follow continuation items in order", async () => {
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
					continuationItems: [track("LMNOPQRSTUV", "Second song")],
				},
			},
		],
	});
	const execute = mock(async () => first)
		.mockResolvedValueOnce(first)
		.mockResolvedValueOnce(next);
	const items = await loadArtistCategoryItems(
		{ execute } as unknown as Actions,
		category,
		"Artist",
		artistId,
		new AbortController().signal,
	);

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
