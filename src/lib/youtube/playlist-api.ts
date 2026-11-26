import { type Innertube, YTNodes } from "youtubei.js/web";
import type { LibraryPlaylist } from "../music/playlist";
import { biggestThumb, hiResThumb } from "../utils/utils";
import { getYoutubeClient } from "./client-session";
import { canonicalPlaylistId, playlistBrowseId } from "./playlist-id";
import { findKey } from "./response-data";

export type Playlist = Awaited<ReturnType<Innertube["music"]["getPlaylist"]>>;

export type Album = Awaited<ReturnType<Innertube["music"]["getAlbum"]>>;

export async function getPlaylist(id: string) {
	const client = await getYoutubeClient();
	try {
		return await client.music.getPlaylist(id);
	} catch (error) {
		console.error("Failed to get playlist:", error);
		return null;
	}
}

async function getUserPlaylists() {
	const client = await getYoutubeClient();
	try {
		return await client.music.getLibrary();
	} catch (error) {
		console.error("Failed to get playlists:", error);
		return null;
	}
}

export async function fetchLibraryPlaylists(): Promise<LibraryPlaylist[]> {
	const library = await getUserPlaylists();
	if (!library) throw new Error("Could not load the playlist library");
	// The library renders playlists either as square grid tiles
	// (MusicTwoRowItem) or as list rows (MusicResponsiveListItem),
	// depending on the section layout — accept both.
	const list: LibraryPlaylist[] = [];
	for (const section of library.contents ?? []) {
		for (const item of section.contents ?? []) {
			if (item.is(YTNodes.MusicTwoRowItem)) {
				if (item.item_type !== "playlist" || !item.id) continue;
				const thumbs = item.thumbnail ?? [];
				list.push({
					id: item.id,
					title: item.title?.text || "Unknown Title",
					subtitle: item.subtitle?.text || "",
					thumbnail: hiResThumb(biggestThumb(thumbs)?.url),
				});
			} else if (item.is(YTNodes.MusicResponsiveListItem)) {
				if (item.item_type !== "playlist" || !item.id) continue;
				const thumbs = item.thumbnail?.contents ?? [];
				list.push({
					id: item.id,
					title: item.title || "Unknown Title",
					subtitle: item.subtitle?.text || "",
					thumbnail: hiResThumb(biggestThumb(thumbs)?.url),
				});
			}
		}
	}
	return list;
}

export async function addSongToPlaylist(playlistId: string, videoId: string) {
	const client = await getYoutubeClient();
	await client.playlist.addVideos(canonicalPlaylistId(playlistId), [videoId]);
}

/**
 * Walks a raw browse response collecting the per-entry setVideoId — the key
 * YouTube's edit endpoint removes an entry by (a video can appear twice).
 */
function collectSetVideoIds(
	node: unknown,
	videoId: string,
	out: Set<string>,
): void {
	if (Array.isArray(node)) {
		for (const item of node) collectSetVideoIds(item, videoId, out);
		return;
	}
	if (!node || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	const entry = record.playlistItemData as
		| { videoId?: string; playlistSetVideoId?: string }
		| undefined;
	if (entry?.videoId === videoId && entry.playlistSetVideoId) {
		out.add(entry.playlistSetVideoId);
	}
	for (const value of Object.values(record)) {
		collectSetVideoIds(value, videoId, out);
	}
}

/** First continuation token in a raw browse response. */
function findContinuationToken(node: unknown): string | null {
	if (Array.isArray(node)) {
		for (const item of node) {
			const token = findContinuationToken(item);
			if (token) return token;
		}
		return null;
	}
	if (!node || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;
	const command = record.continuationCommand as { token?: string } | undefined;
	if (command?.token) return command.token;
	const next = record.nextContinuationData as
		| { continuation?: string }
		| undefined;
	if (next?.continuation) return next.continuation;
	for (const value of Object.values(record)) {
		const token = findContinuationToken(value);
		if (token) return token;
	}
	return null;
}

/** Finds the setVideoId of a track, following playlist pages as needed. */
async function findSetVideoId(
	client: Innertube,
	playlistId: string,
	videoId: string,
	occurrence: number,
): Promise<string | null> {
	const browseId = playlistBrowseId(playlistId);
	const seen = new Set<string>();
	const ids = new Set<string>();
	let continuation: string | null = null;
	for (;;) {
		const response = await client.actions.execute(
			"/browse",
			continuation
				? { continuation, client: "YTMUSIC" }
				: { browseId, client: "YTMUSIC" },
		);
		collectSetVideoIds(response.data, videoId, ids);
		if (ids.size > occurrence) return Array.from(ids)[occurrence];
		const next = findContinuationToken(response.data);
		if (!next || seen.has(next)) return null;
		seen.add(next);
		continuation = next;
	}
}

/**
 * Removes a video from a playlist the user owns. The library's
 * `playlist.removeVideos` cannot be used: it looks for `PlaylistVideo`
 * entries, but YouTube now serves `LockupView` rows the parser exposes
 * without ids, so it never finds the track and throws.
 */
export async function removeSongFromPlaylist(
	playlistId: string,
	videoId: string,
	occurrence: number,
	entryId?: string,
) {
	const client = await getYoutubeClient();
	const setVideoId =
		entryId ?? (await findSetVideoId(client, playlistId, videoId, occurrence));
	if (!setVideoId) throw new Error("Song not found in the playlist");
	await editPlaylistActions(client, playlistId, [
		{ action: "ACTION_REMOVE_VIDEO", setVideoId },
	]);
}

export async function createPlaylist(title: string, videoId: string) {
	const client = await getYoutubeClient();
	await client.playlist.create(title, [videoId]);
}

/**
 * Deletes a playlist the user owns. Calls the endpoint directly because the
 * library's `playlist.delete` builds an empty request body (upstream bug).
 */
export async function deletePlaylist(playlistId: string) {
	const client = await getYoutubeClient();
	const response = await client.actions.execute("/playlist/delete", {
		playlistId: canonicalPlaylistId(playlistId),
	});
	if (!response.success) {
		throw new Error(`Playlist delete failed (HTTP ${response.status_code})`);
	}
}

export type PlaylistPrivacy = "PUBLIC" | "UNLISTED" | "PRIVATE";

export interface PlaylistEdit {
	title?: string;
	description?: string;
	privacy?: PlaylistPrivacy;
}

async function editPlaylistActions(
	client: Innertube,
	playlistId: string,
	actions: Array<Record<string, unknown>>,
): Promise<unknown> {
	const response = await client.actions.execute("/browse/edit_playlist", {
		playlistId: canonicalPlaylistId(playlistId),
		actions,
		// Music-only actions (custom thumbnails) are rejected with the default
		// WEB client context; run every playlist edit as YouTube Music.
		client: "YTMUSIC",
	});
	// The endpoint answers 200 even when the edit was refused; the refusal is
	// marked by STATUS_FAILED in the body.
	const failed =
		(response.data as { status?: string } | undefined)?.status ===
		"STATUS_FAILED";
	if (!response.success || failed) {
		throw new Error(`Playlist edit failed (HTTP ${response.status_code})`);
	}
	return response.data;
}

function lastThumbnailUrl(node: unknown): string | null {
	if (Array.isArray(node)) {
		for (const item of node) {
			const url = lastThumbnailUrl(item);
			if (url) return url;
		}
		return null;
	}
	if (!node || typeof node !== "object") return null;
	const record = node as Record<string, unknown>;
	const thumbnails = record.thumbnails;
	if (Array.isArray(thumbnails) && thumbnails.length > 0) {
		let best: { url?: string; width?: number; height?: number } | null = null;
		for (const candidate of thumbnails) {
			const entry = candidate as {
				url?: string;
				width?: number;
				height?: number;
			};
			if (!entry?.url) continue;
			const area = (entry.width ?? 0) * (entry.height ?? 0);
			if (!best || area > (best.width ?? 0) * (best.height ?? 0)) {
				best = entry;
			}
		}
		const url = best?.url;
		if (url) return url;
	}
	for (const value of Object.values(record)) {
		const url = lastThumbnailUrl(value);
		if (url) return url;
	}
	return null;
}

/**
 * The playlist's cover as the edit left it — the edit response echoes the
 * updated header, which is fresher than a follow-up browse (that can still
 * serve the old image for a while). Null when the response omits it.
 */
function editedThumbnailUrl(data: unknown): string | null {
	const header = findKey(data, "newHeader");
	return header ? lastThumbnailUrl(header) : null;
}

/** Applies metadata edits (name, description, visibility) to an owned playlist. */
export async function updatePlaylist(playlistId: string, edit: PlaylistEdit) {
	const actions: Array<Record<string, unknown>> = [];
	if (edit.title !== undefined) {
		actions.push({
			action: "ACTION_SET_PLAYLIST_NAME",
			playlistName: edit.title,
		});
	}
	if (edit.description !== undefined) {
		actions.push({
			action: "ACTION_SET_PLAYLIST_DESCRIPTION",
			playlistDescription: edit.description,
		});
	}
	if (edit.privacy !== undefined) {
		actions.push({
			action: "ACTION_SET_PLAYLIST_PRIVACY",
			playlistPrivacy: edit.privacy,
		});
	}
	if (actions.length === 0) return;
	const client = await getYoutubeClient();
	await editPlaylistActions(client, playlistId, actions);
}

const PLAYLIST_UPLOAD_URL =
	"https://music.youtube.com/playlist_image_upload/playlist_custom_thumbnail";

/**
 * Uploads a custom cover for an owned playlist through YouTube's resumable
 * upload endpoint, then applies the returned blob via the edit endpoint.
 * Returns the cover URL echoed in the edit response, when present.
 */
export async function setPlaylistThumbnail(
	playlistId: string,
	image: Uint8Array,
	mimeType: string,
): Promise<string | null> {
	const client = await getYoutubeClient();
	const http = client.session.http;

	const start = await http.fetch(new URL(PLAYLIST_UPLOAD_URL), {
		method: "POST",
		headers: {
			"X-Goog-Api-Format-Version": "1",
			"X-Goog-Upload-Command": "start",
			"X-Goog-Upload-Header-Content-Length": String(image.byteLength),
			"X-Goog-Upload-Header-Content-Type": mimeType,
			"X-Goog-Upload-Protocol": "resumable",
		},
	});
	const uploadId =
		start.headers.get("X-Goog-Upload-Id") ??
		start.headers.get("X-Guploader-Uploadid");
	if (!uploadId) {
		throw new Error("Thumbnail upload was rejected");
	}

	const uploadUrl = new URL(PLAYLIST_UPLOAD_URL);
	uploadUrl.searchParams.set("upload_id", uploadId);
	uploadUrl.searchParams.set("upload_protocol", "resumable");
	const upload = await http.fetch(uploadUrl, {
		method: "POST",
		headers: {
			"Content-Type": mimeType,
			"X-Goog-Api-Format-Version": "1",
			"X-Goog-Upload-Command": "upload, finalize",
			"X-Goog-Upload-Offset": "0",
		},
		// Slice into a fresh, exactly-sized buffer: BodyInit only accepts
		// ArrayBuffer-backed views, not views over an ArrayBufferLike.
		body: image.slice().buffer,
	});
	const result = (await upload.json()) as { encryptedBlobId?: string };
	if (!result.encryptedBlobId) {
		throw new Error("Thumbnail upload failed");
	}

	const data = await editPlaylistActions(client, playlistId, [
		{
			action: "ACTION_SET_CUSTOM_THUMBNAIL",
			addedCustomThumbnail: {
				imageKey: {
					name: "studio_square_thumbnail",
					type: "PLAYLIST_IMAGE_TYPE_CUSTOM_THUMBNAIL",
				},
				playlistScottyEncryptedBlobId: result.encryptedBlobId,
			},
		},
	]);
	return editedThumbnailUrl(data);
}

/**
 * Restores the playlist cover to the default (first video). Returns the cover
 * URL echoed in the edit response, when present.
 */
export async function removePlaylistThumbnail(
	playlistId: string,
): Promise<string | null> {
	const client = await getYoutubeClient();
	const data = await editPlaylistActions(client, playlistId, [
		{ action: "ACTION_REMOVE_CUSTOM_THUMBNAIL" },
	]);
	return editedThumbnailUrl(data);
}

export async function getAlbum(id: string) {
	const client = await getYoutubeClient();
	try {
		return await client.music.getAlbum(id);
	} catch (error) {
		console.error("Failed to get album:", error);
		return null;
	}
}

const CONTINUATION_ATTEMPTS = 3;
const CONTINUATION_BACKOFF_MS = 400;

/**
 * Loads the next page of a playlist. Transient timeouts or throttling would
 * otherwise leave long playlists stuck half-loaded (and their cache marked
 * incomplete), so retry a couple of times with a small backoff.
 */
export async function loadPlaylistContinuation(
	playlist: Playlist,
	signal?: AbortSignal,
) {
	if (!playlist.has_continuation) {
		return null;
	}
	for (let attempt = 1; attempt <= CONTINUATION_ATTEMPTS; attempt++) {
		signal?.throwIfAborted();
		try {
			return await playlist.getContinuation();
		} catch (error) {
			signal?.throwIfAborted();
			if (attempt === CONTINUATION_ATTEMPTS) {
				console.error("Failed to load playlist continuation:", error);
				return null;
			}
			await new Promise((resolve) =>
				setTimeout(resolve, CONTINUATION_BACKOFF_MS * attempt),
			);
		}
	}
	return null;
}
