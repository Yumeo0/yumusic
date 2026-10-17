import { YTNodes } from "youtubei.js/web";
import type { Song } from "@/contexts/player-context";
import { seedSongRatings } from "@/lib/stores/song-ratings";
import { applySongDescription } from "@/lib/utils/description";
import { biggestThumb, hiResThumb } from "@/lib/utils/utils";
import { artistListOf, isAlbumId, videoIdOf } from "./youtube.utils";
import {
	type Album,
	getAlbum,
	getPlaylist,
	loadPlaylistContinuation,
	type Playlist,
	type SongRating,
} from "./youtube-client";

/** Whether parsed credits name a real artist, not the unknown placeholder. */
function hasArtistCredit(artists: Array<{ name: string }>): boolean {
	return artists.some((artist) => {
		const name = artist.name?.trim();
		return !!name && !/^unknown artist$/i.test(name);
	});
}

/** Header-level info used for rows that carry no per-track credit or art. */
export interface RowFallback {
	artists?: Array<{ name: string; id?: string }>;
	thumbnail?: string | null;
}

/**
 * Album rows usually omit both the artist and the artwork (the header holds
 * them), so album pages pass those down as a fallback for rows without them.
 */
function toSong(
	item: YTNodes.MusicResponsiveListItem,
	fallback?: RowFallback,
): Song {
	const artists = artistListOf(item);
	const credit =
		fallback?.artists && !hasArtistCredit(artists) ? fallback.artists : artists;
	const rowThumb = biggestThumb(item.thumbnail?.contents)?.url;
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: credit.map((artist) => artist.name).join(", "),
		artistId: credit.find((artist) => artist.id)?.id,
		artists: credit,
		thumbnail: hiResThumb(rowThumb) || fallback?.thumbnail || "",
		duration: item.duration?.text,
	};
}

/**
 * The account's rating for a playlist/album row. List responses carry a
 * `LikeButton` per track whose `like_status` is the current rating, so these
 * pages know every row's state without extra requests.
 */
export function songRatingEntry(
	item: YTNodes.MusicResponsiveListItem,
): { id: string; rating: SongRating } | null {
	const button = item.menu?.top_level_buttons?.find(
		(entry): entry is YTNodes.LikeButton => entry.is(YTNodes.LikeButton),
	);
	const id = button?.target?.video_id;
	if (!id) return null;
	const status = button.like_status;
	if (status === "LIKE") return { id, rating: "like" };
	if (status === "DISLIKE") return { id, rating: "dislike" };
	if (status === "INDIFFERENT") return { id, rating: null };
	return null;
}

export function collectSongs(
	items: Iterable<
		| YTNodes.MusicResponsiveListItem
		| YTNodes.MusicTwoRowItem
		| YTNodes.ContinuationItem
	>,
	fallback?: RowFallback,
): Song[] {
	const songs: Song[] = [];
	const ratings: Array<{ id: string; rating: SongRating }> = [];
	for (const item of items) {
		if (item.is(YTNodes.MusicResponsiveListItem)) {
			const rating = songRatingEntry(item);
			if (rating) ratings.push(rating);
			const song = toSong(item, fallback);
			if (song.id) songs.push(song);
		}
	}
	// Seed before the caller renders the rows, so their buttons open with the
	// real state instead of neutral.
	seedSongRatings(ratings);
	return songs;
}

function sameArtists(a: Song["artists"], b: Song["artists"]): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every(
		(artist, index) =>
			artist.name === b[index].name && artist.id === b[index].id,
	);
}

function sameSong(a: Song, b: Song): boolean {
	return (
		a.title === b.title &&
		a.artist === b.artist &&
		a.artistId === b.artistId &&
		a.thumbnail === b.thumbnail &&
		a.duration === b.duration &&
		sameArtists(a.artists, b.artists)
	);
}

/**
 * Reconciles a freshly fetched tracklist with the one already on screen.
 * Entries that still exist keep their previous object (matched by id per
 * occurrence, so duplicates line up) unless something about them changed;
 * removed tracks are dropped and new ones added, all in fetched (server)
 * order.
 */
export function mergePlaylistSongs(previous: Song[], fetched: Song[]): Song[] {
	if (previous.length === 0) return fetched;
	const byId = new Map<string, Song[]>();
	for (const song of previous) {
		const bucket = byId.get(song.id);
		if (bucket) bucket.push(song);
		else byId.set(song.id, [song]);
	}
	return fetched.map((song) => {
		const candidate = byId.get(song.id)?.shift();
		if (!candidate) return song;
		// A description-enriched entry keeps its credits across a refresh: the
		// fresh row has no description, so reapply the previous one to it
		// instead of losing the parsed title/artist.
		if (!song.description && candidate.description) {
			return applySongDescription(song, candidate.description);
		}
		return sameSong(candidate, song) ? candidate : song;
	});
}

/** Removes the redundant "Playlist" prefix from YouTube subtitles. */
export function cleanSubtitle(text: string): string {
	return text.replace(/^playlist\s*[•·|:-]?\s*/i, "").trim();
}

/**
 * Artist credits stored on the header. Album track rows omit the artist, so
 * it must be read from the album header instead: the strapline on the current
 * layout ("Nakuru Aitsuki"), the author on older responses.
 */
function headerArtists(
	header: YTNodes.MusicResponsiveHeader | YTNodes.MusicDetailHeader,
): Array<{ name: string; id?: string }> {
	if (header instanceof YTNodes.MusicDetailHeader) {
		const author = header.author;
		return author?.name
			? [
					{
						name: author.name,
						id: author.channel_id?.startsWith("UC")
							? author.channel_id
							: undefined,
					},
				]
			: [];
	}
	const artists: Array<{ name: string; id?: string }> = [];
	for (const run of header.strapline_text_one?.runs ?? []) {
		const name = run.text?.trim();
		if (!name || /^[\s,、&/•·]+$/.test(name)) continue;
		if (artists.some((artist) => artist.name === name)) continue;
		const browseId = (run as { endpoint?: { payload?: { browseId?: string } } })
			.endpoint?.payload?.browseId;
		artists.push({
			name,
			id: browseId?.startsWith("UC") ? browseId : undefined,
		});
	}
	return artists;
}

/**
 * Title, subtitle, cover and header-level artists for a playlist or album.
 * Editable playlist pages wrap their real header one level deep, and albums
 * use a different header class than playlists.
 */
export function collectionHeader(raw: Playlist["header"] | Album["header"]): {
	title: string;
	subtitle: string;
	thumbnail: string | null;
	artists: Array<{ name: string; id?: string }>;
} {
	const header =
		raw instanceof YTNodes.MusicEditablePlaylistDetailHeader ? raw.header : raw;
	if (header instanceof YTNodes.MusicResponsiveHeader) {
		const thumbs = header.thumbnail?.contents ?? [];
		return {
			title: header.title?.text || "Playlist",
			subtitle: header.subtitle?.text || "",
			thumbnail: hiResThumb(biggestThumb(thumbs)?.url),
			artists: headerArtists(header),
		};
	}
	if (header instanceof YTNodes.MusicDetailHeader) {
		return {
			title: header.title?.text || "Album",
			subtitle: header.subtitle?.text || "",
			thumbnail: hiResThumb(biggestThumb(header.thumbnails)?.url),
			artists: headerArtists(header),
		};
	}
	return { title: "Playlist", subtitle: "", thumbnail: null, artists: [] };
}

/**
 * Owned playlists nest an editable header renderer in the browse response.
 * It is checked through the response memo as well: youtubei.js' `header`
 * can resolve to the inner MusicResponsiveHeader instead of the wrapper.
 */
export function isEditablePlaylist(data: Playlist | Album): boolean {
	if (data.header instanceof YTNodes.MusicEditablePlaylistDetailHeader) {
		return true;
	}
	const editable = data.page?.contents_memo?.getType(
		YTNodes.MusicEditablePlaylistDetailHeader,
	);
	return (editable?.length ?? 0) > 0;
}

export type PlaylistPrivacyStatus = "PUBLIC" | "UNLISTED" | "PRIVATE";

export interface PlaylistEditMeta {
	title: string;
	description: string;
	privacy: PlaylistPrivacyStatus | null;
	thumbnail: string | null;
	editable: boolean;
}

/** Reads the edit-form prefill (name, description, visibility) of a playlist. */
export async function fetchPlaylistEditMeta(
	id: string,
): Promise<PlaylistEditMeta | null> {
	const data = await getPlaylist(id);
	if (!data) return null;
	const header = collectionHeader(data.header);
	const editableHeader =
		data.header instanceof YTNodes.MusicEditablePlaylistDetailHeader
			? data.header
			: null;
	const editHeader =
		editableHeader?.edit_header instanceof YTNodes.MusicPlaylistEditHeader
			? editableHeader.edit_header
			: data.page?.contents_memo?.getType(YTNodes.MusicPlaylistEditHeader)[0];
	const rawPrivacy = editHeader?.privacy?.toUpperCase();
	const privacy =
		rawPrivacy === "PUBLIC" ||
		rawPrivacy === "UNLISTED" ||
		rawPrivacy === "PRIVATE"
			? rawPrivacy
			: null;
	const rawHeader = editableHeader ? editableHeader.header : data.header;
	const description =
		rawHeader instanceof YTNodes.MusicResponsiveHeader
			? (rawHeader.description?.description?.toString() ?? "")
			: "";
	return {
		title: header.title,
		description,
		privacy,
		thumbnail: header.thumbnail,
		editable: isEditablePlaylist(data),
	};
}

/**
 * Loads every track of a playlist (all continuation pages), or of an album.
 * `onFirstPage` fires as soon as the first response arrives, so callers can
 * start playback without waiting for the remaining pages.
 */
export async function loadPlaylistSongs(
	id: string,
	onFirstPage?: (songs: Song[]) => void,
): Promise<Song[]> {
	const albumMode = isAlbumId(id);
	const data = albumMode ? await getAlbum(id) : await getPlaylist(id);
	if (!data) throw new Error("Could not load playlist");
	const header = collectionHeader(data.header);
	const items = "items" in data ? (data.items ?? []) : data.contents;
	const rowFallback: RowFallback = {
		artists: albumMode ? header.artists : undefined,
		thumbnail: header.thumbnail,
	};
	const songs = collectSongs(items, rowFallback);
	onFirstPage?.([...songs]);
	if ("has_continuation" in data && data.has_continuation) {
		let current: Playlist = data;
		while (current.has_continuation) {
			const continuation = await loadPlaylistContinuation(current);
			if (!continuation) break;
			current = continuation;
			songs.push(...collectSongs(current.items ?? [], rowFallback));
		}
	}
	return songs;
}
