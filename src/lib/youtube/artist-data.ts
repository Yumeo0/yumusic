import { YTNodes } from "youtubei.js/web";
import type { Song } from "../music/song";
import { LruCache } from "../utils/lru-cache";
import { biggestThumb, hiResThumb } from "../utils/utils";
import { type ArtistShelfItem, artistShelfItems } from "./artist-category";
import {
	channelCardShelves,
	channelProfileThumbnail,
	channelVideos,
} from "./channel-data";
import { getYoutubeClient } from "./client-session";
import { artistMixSource, type MixSource } from "./track-recommendations";

// Auto-sync: fetch on first view, keep for the session, re-sync after 24h.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ArtistShelf {
	title: string;
	items: ArtistShelfItem[];
	category?: string;
}

interface ArtistCategory {
	title: string;
	endpoint: YTNodes.NavigationEndpoint;
}

export interface ArtistView {
	name: string;
	shareUrl: string;
	description: string | null;
	thumbnail: string | null;
	songsTitle: string;
	songsCategory?: string;
	songs: Song[];
	shelves: ArtistShelf[];
	categories: Map<string, ArtistCategory>;
	/** Context for the header's "Mix" (radio) action, when the artist has one. */
	mix: MixSource | null;
}

const artistCache = new LruCache<
	string,
	{ timestamp: number; data: ArtistView }
>(12);

export async function fetchArtistView(
	id: string,
	force = false,
): Promise<ArtistView> {
	const cached = artistCache.get(id);
	if (!force && cached && Date.now() - cached.timestamp < SYNC_INTERVAL_MS) {
		return cached.data;
	}

	const client = await getYoutubeClient();
	const fetchChannel = async (): Promise<ArtistView> => {
		const channel = await client.getChannel(id);
		const metadata = channel.metadata;
		const name = metadata.title || "Channel";
		const uploads = channel.has_videos ? await channel.getVideos() : channel;
		const view: ArtistView = {
			name,
			shareUrl: `https://www.youtube.com/channel/${id}`,
			description: metadata.description || null,
			thumbnail:
				hiResThumb(biggestThumb(metadata.avatar ?? metadata.thumbnail)?.url) ||
				null,
			songsTitle: "Videos",
			songs: channelVideos(uploads.videos, name, id),
			shelves: [],
			categories: new Map(),
			mix: null,
		};
		artistCache.set(id, { timestamp: Date.now(), data: view });
		return view;
	};
	let artist: Awaited<ReturnType<typeof client.music.getArtist>>;
	try {
		artist = await client.music.getArtist(id);
	} catch {
		return fetchChannel();
	}
	const header = artist.header;
	const mix = artistMixSource(header);

	let name = "Artist";
	let description: string | null = null;
	let thumbnail: string | null = null;
	if (header instanceof YTNodes.MusicImmersiveHeader) {
		name = header.title?.text || name;
		description = header.description?.toString() || null;
		thumbnail = hiResThumb(biggestThumb(header.thumbnail?.contents)?.url);
	} else if (header instanceof YTNodes.MusicVisualHeader) {
		name = header.title?.text || name;
		thumbnail = channelProfileThumbnail(header);
	} else if (header instanceof YTNodes.MusicHeader) {
		name = header.title?.text || name;
	}

	const shelves: ArtistShelf[] = channelCardShelves(
		artist.page.contents_memo?.getType(YTNodes.MusicCardShelf) ?? [],
	);
	const categories = new Map<string, ArtistCategory>();
	let songs: Song[] = [];
	let songsTitle = "Songs";
	let songsCategory: string | undefined;

	function registerCategory(
		title: string,
		endpoint: YTNodes.NavigationEndpoint | undefined,
	) {
		if (!endpoint || typeof endpoint.payload?.browseId !== "string") return;
		const slug =
			title
				.toLowerCase()
				.replace(/&/g, " and ")
				.replace(/[^\p{L}\p{N}]+/gu, "-")
				.replace(/^-|-$/g, "") || "items";
		let key = slug;
		for (let suffix = 2; categories.has(key); suffix++) {
			key = `${slug}-${suffix}`;
		}
		categories.set(key, { endpoint, title: title || "Items" });
		return key;
	}

	for (const section of artist.sections ?? []) {
		const carousel = section.is(YTNodes.MusicCarouselShelf);
		const title =
			(carousel ? section.header?.title?.text : section.title?.text) || "";
		const endpoint = carousel
			? section.header?.more_content?.endpoint
			: (section.endpoint ?? section.bottom_button?.endpoint);
		const category = registerCategory(title, endpoint);
		const items = artistShelfItems(section.contents ?? [], name, id);
		if (!carousel && /songs?/i.test(title) && songs.length === 0) {
			const shelfSongs = items.flatMap((item) =>
				item.song ? [item.song] : [],
			);
			if (shelfSongs.length > 0) {
				songs = shelfSongs;
				songsTitle = title;
				songsCategory = category;
				continue;
			}
		}
		if (items.length || category) shelves.push({ title, items, category });
	}

	const view: ArtistView = {
		name,
		shareUrl: `https://music.youtube.com/channel/${id}`,
		description,
		thumbnail,
		songsTitle,
		songsCategory,
		songs,
		shelves,
		categories,
		mix,
	};
	if (!songs.length && !shelves.length) return fetchChannel();
	artistCache.set(id, { timestamp: Date.now(), data: view });
	return view;
}
