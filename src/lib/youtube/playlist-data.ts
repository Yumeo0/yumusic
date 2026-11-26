import { YTNodes } from "youtubei.js/web";
import type { Song } from "@/lib/music/song";
import { seedSongRatings } from "@/lib/stores/song-ratings";
import { biggestThumb, hiResThumb } from "@/lib/utils/utils";
import type { PlaylistTrack, PlaylistView } from "../music/playlist";
import { applySongEnrichment } from "../music/song-enrichment";
import { type RowFallback, songFromMusicRow } from "./music-row";
import {
	type Album,
	getAlbum,
	getPlaylist,
	loadPlaylistContinuation,
	type Playlist,
	type PlaylistPrivacy,
} from "./playlist-api";
import { type SongRating, songRatingEntry } from "./song-rating";
import { isAlbumId } from "./youtube.utils";

function collectSongs(
	items: Iterable<
		| YTNodes.MusicResponsiveListItem
		| YTNodes.MusicTwoRowItem
		| YTNodes.ContinuationItem
	>,
	fallback?: RowFallback,
): PlaylistTrack[] {
	const songs: PlaylistTrack[] = [];
	const ratings: Array<{ id: string; rating: SongRating }> = [];
	for (const item of items) {
		if (item.is(YTNodes.MusicResponsiveListItem)) {
			const rating = songRatingEntry(item);
			if (rating) ratings.push(rating);
			const song = songFromMusicRow(item, fallback);
			if (!song.id) continue;
			const entryId = playlistEntryId(item);
			songs.push(entryId ? { ...song, entryId } : song);
		}
	}
	// Seed before the caller renders the rows, so their buttons open with the
	// real state instead of neutral.
	seedSongRatings(ratings);
	return songs;
}

function playlistEntryId(item: YTNodes.MusicResponsiveListItem) {
	for (const action of item.menu?.items ?? []) {
		if (!action.is(YTNodes.MenuServiceItem)) continue;
		const edits = action.endpoint?.payload?.actions;
		if (!Array.isArray(edits)) continue;
		for (const edit of edits) {
			if (
				edit?.action === "ACTION_REMOVE_VIDEO" &&
				typeof edit.setVideoId === "string" &&
				edit.setVideoId
			)
				return edit.setVideoId;
		}
	}
	return undefined;
}

function sameArtists(a: Song["artists"], b: Song["artists"]): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every(
		(artist, index) =>
			artist.name === b[index].name && artist.id === b[index].id,
	);
}

function sameSong(a: PlaylistTrack, b: PlaylistTrack): boolean {
	return (
		a.entryId === b.entryId &&
		a.title === b.title &&
		a.artist === b.artist &&
		a.artistId === b.artistId &&
		a.thumbnail === b.thumbnail &&
		a.duration === b.duration &&
		a.description === b.description &&
		a.upload === b.upload &&
		a.addedBy === b.addedBy &&
		sameArtists(a.creditIds, b.creditIds) &&
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
export function mergePlaylistSongs(
	previous: PlaylistTrack[],
	fetched: PlaylistTrack[],
): PlaylistTrack[] {
	if (previous.length === 0) return fetched;
	const byId = new Map<string, PlaylistTrack[]>();
	for (const song of previous) {
		const key = song.entryId ? `entry:${song.entryId}` : song.id;
		const bucket = byId.get(key);
		if (bucket) bucket.push(song);
		else byId.set(key, [song]);
	}
	return fetched.map((song) => {
		const candidate = song.entryId
			? (byId.get(`entry:${song.entryId}`)?.shift() ??
				byId.get(song.id)?.shift())
			: byId.get(song.id)?.shift();
		if (!candidate) return song;
		// A description-enriched entry keeps its credits across a refresh: the
		// fresh row has no description, so reapply the previous one to it
		// instead of losing the parsed title/artist.
		const enriched = applySongEnrichment(song, {
			description: candidate.description,
			upload: candidate.upload || undefined,
		});
		return sameSong(candidate, enriched) ? candidate : enriched;
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
function collectionHeader(raw: Playlist["header"] | Album["header"]): {
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
function isEditablePlaylist(data: Playlist | Album): boolean {
	if (data.header instanceof YTNodes.MusicEditablePlaylistDetailHeader) {
		return true;
	}
	const editable = data.page?.contents_memo?.getType(
		YTNodes.MusicEditablePlaylistDetailHeader,
	);
	return (editable?.length ?? 0) > 0;
}

interface PlaylistEditMeta {
	title: string;
	description: string;
	privacy: PlaylistPrivacy | null;
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

interface PlaylistLoadOptions {
	signal?: AbortSignal;
	onFirstPage?: (view: PlaylistView) => void;
	onContinuation?: (batch: Song[]) => void;
}

/** Resolves the best available snapshot; complete is false if continuation failed. */
export async function loadPlaylistView(
	id: string,
	{ signal, onFirstPage, onContinuation }: PlaylistLoadOptions = {},
): Promise<PlaylistView | null> {
	const albumMode = isAlbumId(id);
	signal?.throwIfAborted();
	const data = albumMode ? await getAlbum(id) : await getPlaylist(id);
	signal?.throwIfAborted();
	if (!data) return null;
	const header = collectionHeader(data.header);
	const rowFallback: RowFallback = {
		artists: albumMode ? header.artists : undefined,
		thumbnail: header.thumbnail,
	};
	const firstSongs = collectSongs(
		"items" in data ? (data.items ?? []) : data.contents,
		rowFallback,
	);
	let current = "has_continuation" in data ? data : null;
	const view = {
		id,
		title: header.title,
		subtitle: cleanSubtitle(header.subtitle),
		thumbnail: header.thumbnail,
		songs: firstSongs,
		complete: !current?.has_continuation,
		editable: !albumMode && isEditablePlaylist(data),
	};
	onFirstPage?.(view);
	if (view.complete) return view;

	const songs = [...firstSongs];
	while (current?.has_continuation) {
		signal?.throwIfAborted();
		const continuation = await loadPlaylistContinuation(current);
		signal?.throwIfAborted();
		if (!continuation) return { ...view, songs };
		current = continuation;
		const batch = collectSongs(current.items ?? [], rowFallback);
		songs.push(...batch);
		onContinuation?.(batch);
	}
	return { ...view, songs, complete: true };
}
