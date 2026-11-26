import {
	type Actions,
	GridContinuation,
	type Helpers,
	type IParsedResponse,
	MusicPlaylistShelfContinuation,
	MusicShelfContinuation,
	ReloadContinuationItemsCommand,
	SectionListContinuation,
	YTNodes,
} from "youtubei.js/web";
import type { Song } from "@/lib/music/song";
import { seedSongRatings } from "@/lib/stores/song-ratings";
import { biggestThumb, hiResThumb } from "@/lib/utils/utils";
import { songFromMusicRow } from "./music-row";
import { type SongRating, songRatingEntry } from "./song-rating";
import { videoIdOf } from "./youtube.utils";

export interface ArtistShelfItem {
	title: string;
	subtitle: string;
	thumbnail: string | null;
	song?: Song;
	link?: string;
}

function collectionLink(type: string | undefined, id: string | undefined) {
	if (!id) return undefined;
	switch (type) {
		case "album":
		case "playlist":
			return `/playlists/${encodeURIComponent(id)}`;
		case "artist":
		case "library_artist":
			return `/artist/${encodeURIComponent(id)}`;
	}
}

export function artistShelfItems(
	nodes: Iterable<Helpers.YTNode>,
	artistName: string,
	artistId: string,
): ArtistShelfItem[] {
	const items: ArtistShelfItem[] = [];
	const ratings: Array<{ id: string; rating: SongRating }> = [];

	for (const node of nodes) {
		if (node.is(YTNodes.MusicResponsiveListItem)) {
			const rating = songRatingEntry(node);
			if (rating) ratings.push(rating);
			const song = songFromMusicRow(node);
			if (song.id) {
				items.push({
					title: song.title,
					subtitle: song.artist,
					thumbnail: song.thumbnail,
					song,
				});
			} else {
				const link = collectionLink(
					node.item_type,
					node.id ?? node.endpoint?.payload?.browseId,
				);
				if (link) {
					items.push({
						title: song.title,
						subtitle: node.subtitle?.text || "",
						thumbnail: song.thumbnail,
						link,
					});
				}
			}
		} else if (node.is(YTNodes.MusicTwoRowItem)) {
			const title = node.title?.text || "Unknown Title";
			const thumbnail = hiResThumb(biggestThumb(node.thumbnail)?.url);
			const id = videoIdOf(node);
			items.push({
				title,
				subtitle: node.subtitle?.text || "",
				thumbnail,
				link: collectionLink(node.item_type, node.id),
				song: id
					? {
							id,
							title,
							artist: artistName,
							artistId,
							artists: [{ name: artistName, id: artistId }],
							thumbnail,
						}
					: undefined,
			});
		}
	}

	seedSongRatings(ratings);
	return items;
}

function readCategoryPage(page: IParsedResponse) {
	const memo = page.contents_memo;
	const sections = memo?.getType(YTNodes.SectionList)[0];
	const containers: Helpers.YTNode[] = sections
		? [sections]
		: (memo?.getType(
				YTNodes.Grid,
				YTNodes.MusicShelf,
				YTNodes.MusicPlaylistShelf,
				YTNodes.MusicCarouselShelf,
			) ?? []);
	const nodes: Helpers.YTNode[] = [];
	let continuation: YTNodes.NavigationEndpoint | string | undefined;

	function visit(node: Helpers.YTNode) {
		if (node.is(YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem)) {
			nodes.push(node);
		} else if (node.is(YTNodes.ContinuationItem)) {
			continuation ??= node.endpoint;
		} else if (
			node.is(
				YTNodes.Grid,
				YTNodes.SectionList,
				YTNodes.MusicShelf,
				YTNodes.MusicPlaylistShelf,
				GridContinuation,
				SectionListContinuation,
				MusicShelfContinuation,
				MusicPlaylistShelfContinuation,
			)
		) {
			for (const child of node.contents ?? []) visit(child);
			continuation ??= node.continuation || undefined;
		} else if (
			node.is(
				YTNodes.MusicCarouselShelf,
				YTNodes.AppendContinuationItemsAction,
				ReloadContinuationItemsCommand,
			)
		) {
			for (const child of node.contents ?? []) visit(child);
		}
	}

	for (const node of containers) visit(node);
	if (page.continuation_contents) visit(page.continuation_contents);
	for (const actions of [
		page.on_response_received_actions,
		page.on_response_received_endpoints,
		page.on_response_received_commands,
	]) {
		for (const action of actions ?? []) visit(action);
	}
	return { nodes, continuation };
}

export async function loadArtistCategoryItems(
	actions: Actions,
	endpoint: YTNodes.NavigationEndpoint,
	artistName: string,
	artistId: string,
	signal: AbortSignal,
	onPage?: (items: ArtistShelfItem[], hasMore: boolean) => void,
) {
	const items: ArtistShelfItem[] = [];
	const seenItems = new Set<string>();
	const seenTokens = new Set<string>();
	signal.throwIfAborted();
	let page = await endpoint.call(actions, { client: "YTMUSIC", parse: true });

	for (;;) {
		signal.throwIfAborted();
		const { nodes: nextNodes, continuation } = readCategoryPage(page);
		// Some artist tabs arrive without their contents. Let the user retry
		// instead of presenting a failed response as an empty category.
		if (
			nextNodes.length === 0 &&
			!continuation &&
			page.contents_memo
				?.getType(YTNodes.Tab)
				.some((tab) => tab.selected && !tab.content)
		) {
			throw new Error("YouTube Music returned an unloaded artist tab.");
		}
		const batch = artistShelfItems(nextNodes, artistName, artistId).filter(
			(item) => {
				const key = item.song
					? `song:${item.song.id}`
					: (item.link ??
						JSON.stringify([item.title, item.subtitle, item.thumbnail]));
				if (seenItems.has(key)) return false;
				seenItems.add(key);
				return true;
			},
		);
		items.push(...batch);
		onPage?.(batch, Boolean(continuation));
		if (!continuation) return items;
		signal.throwIfAborted();

		const token =
			typeof continuation === "string"
				? continuation
				: continuation.payload?.token;
		if (typeof token === "string") {
			if (seenTokens.has(token))
				throw new Error("Artist continuation repeated.");
			seenTokens.add(token);
		}
		page =
			typeof continuation === "string"
				? await actions.execute("/browse", {
						client: "YTMUSIC",
						continuation,
						parse: true,
					})
				: await continuation.call(actions, { client: "YTMUSIC", parse: true });
	}
}
