import {
	Innertube,
	Platform,
	type Types,
	UniversalCache,
	Utils,
	YT,
	YTNodes,
} from "youtubei.js/web";
import type { LrcLine } from "../lyrics/lrclib";
import { LruCache } from "../utils/lru-cache";
import { NEEDS_BODY_HEADER, PROXY_ORIGIN } from "../utils/tauri";
import { biggestThumb, hiResThumb } from "../utils/utils";
import { botguardService } from "./botguard-service";
import { getOembedMetadata } from "./oembed";
import { type SongVersion, songVersionEntryFromQueue } from "./song-version";

/** Base64-encodes a request body for transport inside an HTTP header. */
async function bodyToBase64(body: BodyInit): Promise<string | null> {
	let bytes: Uint8Array;
	if (typeof body === "string") {
		bytes = new TextEncoder().encode(body);
	} else if (body instanceof Blob) {
		bytes = new Uint8Array(await body.arrayBuffer());
	} else if (body instanceof ArrayBuffer) {
		bytes = new Uint8Array(body);
	} else if (ArrayBuffer.isView(body)) {
		bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	} else {
		return null;
	}
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export type Playlist = Awaited<ReturnType<Innertube["music"]["getPlaylist"]>>;
export type Library = Awaited<ReturnType<Innertube["music"]["getLibrary"]>>;
export type HomeFeed = Awaited<ReturnType<Innertube["music"]["getHomeFeed"]>>;

interface ClientSlot {
	instance: Innertube | null;
	/** Cookie the cached client was built with (`null` = signed out). */
	cookie: string | null;
	/** In-flight creation, shared by callers asking for the same auth state. */
	pending: Promise<Innertube> | null;
	pendingCookie: string | null;
}

function createSlot(): ClientSlot {
	return { instance: null, cookie: null, pending: null, pendingCookie: null };
}

// The app always fetches in English (matching the UI). A single client suffices
// because `hl` lives on the shared session.
const enClientSlot = createSlot();

// Set up JavaScript evaluator for deciphering URLs
Platform.shim.eval = async (
	data: Types.BuildScriptResult,
	env: Record<string, Types.VMPrimative>,
) => {
	const properties = [];

	if (env.n) {
		properties.push(`n: exportedVars.nFunction("${env.n}")`);
	}

	if (env.sig) {
		properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
	}

	const code = `${data.output}\nreturn { ${properties.join(", ")} }`;

	return new Function(code)();
};

export async function fetchFunction(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const userCookie = await window.electron.getCookie();

	const urlStr =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	const url = new URL(urlStr);

	const proxyUrl = new URL(`${PROXY_ORIGIN}${url.pathname}${url.search}`);
	proxyUrl.searchParams.set("__host", url.host);

	const headersObj: Record<string, string> = {};

	// Helper to extract headers from HeadersInit
	const extractHeaders = (headers?: HeadersInit) => {
		if (!headers) return;
		if (headers instanceof Headers) {
			headers.forEach((value, key) => {
				headersObj[key] = value;
			});
		} else if (Array.isArray(headers)) {
			headers.forEach(([key, value]) => {
				headersObj[key] = value;
			});
		} else {
			Object.entries(headers).forEach(([key, value]) => {
				headersObj[key] = value as string;
			});
		}
	};

	if (input instanceof Request) {
		extractHeaders(input.headers);
	}
	if (init?.headers) {
		extractHeaders(init.headers);
	}

	// Ensure cookie is present if we have it
	if (userCookie && !headersObj.cookie && !headersObj.Cookie) {
		headersObj.Cookie = userCookie;
	}

	let body: BodyInit | null = null;
	const method =
		init?.method || (input instanceof Request ? input.method : "GET");

	// Only read body for non-GET/HEAD requests
	if (method !== "GET" && method !== "HEAD") {
		if (init?.body) {
			body = init.body;
		} else if (input instanceof Request && input.body) {
			try {
				body = await input.blob();
			} catch (error) {
				console.error("[fetchFunction] Failed to read body:", error);
			}
		}
	}

	// Propagate SABR cancellation so skipped tracks stop retaining response buffers.
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		console.error("[fetchFunction] Request timed out after 30 seconds");
		controller.abort();
	}, 30000);
	try {
		const proxyHeaders: Record<string, string> = {
			"X-Proxy-Headers": JSON.stringify(headersObj),
		};
		if (NEEDS_BODY_HEADER && body != null) {
			const encoded = await bodyToBase64(body);
			if (encoded) proxyHeaders["X-Proxy-Body"] = encoded;
		}

		const response = await fetch(proxyUrl.toString(), {
			method: method,
			headers: proxyHeaders,
			body: body,
			signal: AbortSignal.any([
				controller.signal,
				...(init?.signal
					? [init.signal]
					: input instanceof Request
						? [input.signal]
						: []),
			]),
		});

		clearTimeout(timeoutId);
		if (!response.ok) {
			response
				.clone()
				.text()
				.then((body) =>
					console.error("[fetchFunction] Error body:", body.slice(0, 600)),
				)
				.catch(() => undefined);
		}
		return response;
	} catch (error) {
		console.error("[fetchFunction] Fetch failed:", error);
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

// Bun's `fetch` type carries a `preconnect` member; provide a no-op so
// the custom fetch is assignable to youtubei.js' `typeof fetch` option.
Object.assign(fetchFunction, { preconnect: () => undefined });

/**
 * Returns a cached Innertube client for the given language slot, creating it at
 * most once per auth state. Concurrent callers share the in-flight creation,
 * and a signed-out creation can never replace an already-authenticated client —
 * without these guarantees, data fetches that start before the login cookie is
 * available (the home feed mounts before the layout's login check) could
 * clobber the session and silently drop the account: wrong recommendations, an
 * empty library and a nameless "User" in the sidebar.
 */
async function getClientFromSlot(
	slot: ClientSlot,
	lang: string,
	cookie?: string,
): Promise<Innertube> {
	const desired = cookie || (await window.electron.getCookie()) || null;

	// Reuse the current client when it already matches; never downgrade an
	// authenticated client just because no cookie was available this call.
	if (slot.instance && (desired === slot.cookie || !desired)) {
		return slot.instance;
	}

	// Share an in-flight creation for the same auth state.
	if (slot.pending && slot.pendingCookie === desired) {
		return slot.pending;
	}

	slot.pendingCookie = desired;
	let pending: Promise<Innertube>;
	pending = Innertube.create({
		cache: new UniversalCache(false),
		generate_session_locally: true,
		cookie: desired || undefined,
		lang,
		// Bun's `fetch` type carries a required `preconnect` member that the
		// DOM-flavored custom fetch lacks; the runtime object satisfies it
		// via the Object.assign above.
		fetch: fetchFunction as typeof fetch,
	})
		.then((client) => {
			// Only adopt this client if no newer auth state was requested while
			// this creation was in flight.
			if (slot.pendingCookie === desired) {
				slot.instance = client;
				slot.cookie = desired;
			}
			return client;
		})
		.finally(() => {
			if (slot.pending === pending) {
				slot.pending = null;
				slot.pendingCookie = null;
			}
		});
	slot.pending = pending;

	return pending;
}

/** The app's Innertube client, pinned to English to match the UI. */
export function getYoutubeClient(cookie?: string) {
	return getClientFromSlot(enClientSlot, "en", cookie);
}

export async function getUserProfile() {
	const client = await getYoutubeClient();
	try {
		// getInfo(true) uses the WEB client channel-switcher endpoint, which is
		// the variant that works with cookie-based sessions. The default
		// getInfo() uses the TV client, whose response has no contents here.
		const accounts = await client.account.getInfo(true);

		const selected = accounts.find((item) => item.is_selected) ?? accounts[0];

		if (!selected) return null;

		return {
			name: selected.account_name?.text,
			photo: selected.account_photo?.[0]?.url,
		};
	} catch (error) {
		console.error("Failed to get user profile:", error);
		return null;
	}
}

export async function getUserPlaylists() {
	const client = await getYoutubeClient();
	try {
		const library = await client.music.getLibrary();
		// The library usually contains sections like "Recent activity", "Playlists", etc.
		// We want to find the playlists section or just return everything for now to inspect
		return library;
	} catch (error) {
		console.error("Failed to get playlists:", error);
		return null;
	}
}

/** The account's rating for a song; null means "not rated". */
export type SongRating = "like" | "dislike" | null;

/**
 * Sets the signed-in account's rating for a video; null clears it. YouTube
 * treats repeating the current rating as a no-op, so callers can toggle
 * without tracking the previous state.
 *
 * youtubei.js' InteractionManager passes the video id as a bare string, which
 * the like endpoints now reject ("Invalid value at 'target'"); the API wants
 * a `LikeTarget` object (`{ videoId }`). The endpoints are called directly
 * with the YouTube Music context, matching its web player.
 */
export async function setSongRating(
	videoId: string,
	rating: SongRating,
): Promise<void> {
	const client = await getYoutubeClient();
	if (!client.session.logged_in) {
		throw new Error("You must be signed in to rate songs.");
	}
	const endpoint =
		rating === "like"
			? "/like/like"
			: rating === "dislike"
				? "/like/dislike"
				: "/like/removelike";
	const response = await client.actions.execute(endpoint, {
		target: { videoId },
		client: "YTMUSIC",
	});
	if (!response.success) {
		throw new Error(`Rating update failed (HTTP ${response.status_code})`);
	}
}

/**
 * Reads the account's current rating for a video. The web watch-next response
 * omits the rating, but the TV client's transport controls carry a
 * `likeButtonRenderer` whose `likeStatus` is the account's rating. Resolves
 * to `undefined` when it cannot be determined (signed out or no button), so
 * callers can leave the buttons neutral.
 */
export async function getSongRating(
	videoId: string,
): Promise<SongRating | undefined> {
	try {
		const client = await getYoutubeClient();
		if (!client.session.logged_in) return undefined;
		const response = await client.actions.execute("/next", {
			videoId,
			client: "TV",
		});
		const likeButton = findKey(response.data, "likeButtonRenderer") as
			| { likeStatus?: string }
			| undefined;
		const status = likeButton?.likeStatus;
		if (status === "LIKE") return "like";
		if (status === "DISLIKE") return "dislike";
		if (status === "INDIFFERENT") return null;
		return undefined;
	} catch (error) {
		console.warn("[YuMusic] failed to read the song rating:", error);
		return undefined;
	}
}

export async function getPlaylist(id: string) {
	const client = await getYoutubeClient();
	try {
		const playlist = await client.music.getPlaylist(id);
		return playlist;
	} catch (error) {
		console.error("Failed to get playlist:", error);
		return null;
	}
}

export interface LibraryPlaylist {
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string | null;
}

let libraryPlaylistsCache: LibraryPlaylist[] | null = null;

/**
 * The user's playlists from the library — shared by the playlists page and
 * the "Add to playlist" dialog. Cached for the session unless `force` is set.
 */
export async function getLibraryPlaylists(
	force = false,
): Promise<LibraryPlaylist[]> {
	if (!force && libraryPlaylistsCache) return libraryPlaylistsCache;
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
	libraryPlaylistsCache = list;
	return list;
}

/** The edit endpoint expects the raw id, without the browse-id "VL" prefix. */
function editablePlaylistId(id: string): string {
	return id.startsWith("VL") ? id.slice(2) : id;
}

/** Adds a video to a playlist the user owns. */
export async function addSongToPlaylist(playlistId: string, videoId: string) {
	const client = await getYoutubeClient();
	await client.playlist.addVideos(editablePlaylistId(playlistId), [videoId]);
}

/**
 * Walks a raw browse response collecting the per-entry setVideoId — the key
 * YouTube's edit endpoint removes an entry by (a video can appear twice).
 */
function collectSetVideoIds(node: unknown, out: Map<string, string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectSetVideoIds(item, out);
		return;
	}
	if (!node || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	const entry = record.playlistItemData as
		| { videoId?: string; playlistSetVideoId?: string }
		| undefined;
	if (entry?.videoId && entry.playlistSetVideoId && !out.has(entry.videoId)) {
		out.set(entry.videoId, entry.playlistSetVideoId);
	}
	for (const value of Object.values(record)) {
		collectSetVideoIds(value, out);
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
): Promise<string | null> {
	const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
	const seen = new Set<string>();
	let continuation: string | null = null;
	for (let page = 0; page < 6; page++) {
		const response = await client.actions.execute(
			"/browse",
			continuation
				? { continuation, client: "YTMUSIC" }
				: { browseId, client: "YTMUSIC" },
		);
		const ids = new Map<string, string>();
		collectSetVideoIds(response.data, ids);
		const found = ids.get(videoId);
		if (found) return found;
		const next = findContinuationToken(response.data);
		if (!next || seen.has(next)) return null;
		seen.add(next);
		continuation = next;
	}
	return null;
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
) {
	const client = await getYoutubeClient();
	const setVideoId = await findSetVideoId(client, playlistId, videoId);
	if (!setVideoId) throw new Error("Song not found in the playlist");
	const response = await client.actions.execute("/browse/edit_playlist", {
		playlistId: editablePlaylistId(playlistId),
		actions: [{ action: "ACTION_REMOVE_VIDEO", setVideoId }],
	});
	if (!response.success) {
		throw new Error(`Playlist edit failed (HTTP ${response.status_code})`);
	}
}

/** Creates a playlist, optionally with a first video. Returns its id. */
export async function createPlaylist(
	title: string,
	videoId?: string,
): Promise<string | null> {
	const client = await getYoutubeClient();
	const result = await client.playlist.create(title, videoId ? [videoId] : []);
	libraryPlaylistsCache = null;
	return result.playlist_id ?? null;
}

/**
 * Deletes a playlist the user owns. Calls the endpoint directly because the
 * library's `playlist.delete` builds an empty request body (upstream bug).
 */
export async function deletePlaylist(playlistId: string) {
	const client = await getYoutubeClient();
	const response = await client.actions.execute("/playlist/delete", {
		playlistId: editablePlaylistId(playlistId),
	});
	if (!response.success) {
		throw new Error(`Playlist delete failed (HTTP ${response.status_code})`);
	}
	libraryPlaylistsCache = null;
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
		playlistId: editablePlaylistId(playlistId),
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

function findKey(node: unknown, key: string): unknown {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findKey(item, key);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	if (key in record) return record[key];
	for (const value of Object.values(record)) {
		const found = findKey(value, key);
		if (found !== undefined) return found;
	}
	return undefined;
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

export type Album = Awaited<ReturnType<Innertube["music"]["getAlbum"]>>;
export type Artist = Awaited<ReturnType<Innertube["music"]["getArtist"]>>;

export async function getAlbum(id: string) {
	const client = await getYoutubeClient();
	try {
		const album = await client.music.getAlbum(id);
		return album;
	} catch (error) {
		console.error("Failed to get album:", error);
		return null;
	}
}

/** A playable track produced by the app (structurally the player's `Song`). */
export interface AutoplayTrack {
	id: string;
	title: string;
	artist: string;
	artistId?: string;
	artists?: Array<{ name: string; id?: string }>;
	thumbnail: string;
	duration?: string;
}

/** Converts a queue panel's videos into playable tracks, skipping `skipId`. */
function panelTracks(
	panel: YTNodes.PlaylistPanel,
	skipId?: string,
): AutoplayTrack[] {
	const tracks: AutoplayTrack[] = [];
	for (const item of panel.contents) {
		const video = item.is(YTNodes.PlaylistPanelVideo)
			? item
			: item.is(YTNodes.PlaylistPanelVideoWrapper) && item.primary
				? item.primary
				: null;
		if (!video || video.video_id === skipId) continue;
		const artists = (video.artists ?? [])
			.filter((artist) => artist.name)
			.map((artist) => ({
				name: artist.name,
				id: artist.channel_id?.startsWith("UC") ? artist.channel_id : undefined,
			}));
		tracks.push({
			id: video.video_id,
			title: video.title.toString() || "Unknown Title",
			artist:
				artists
					.map((artist) => artist.name)
					.filter(Boolean)
					.join(", ") ||
				video.author ||
				"",
			artistId: artists.find((artist) => artist.id)?.id,
			artists: artists.length > 0 ? artists : undefined,
			thumbnail: hiResThumb(biggestThumb(video.thumbnail)?.url),
			duration: video.duration?.text,
		});
	}
	return tracks;
}

/**
 * Similar tracks to keep playing once the queue ends — YouTube Music's "Up
 * next" mix for the given video (automix fallback included). The current track
 * itself is skipped; returns `[]` when there is nothing to extend with.
 */
export async function getAutoplaySongs(
	videoId: string,
): Promise<AutoplayTrack[]> {
	try {
		const client = await getYoutubeClient();
		const panel = await client.music.getUpNext(videoId, true);
		return panelTracks(panel, videoId);
	} catch (error) {
		console.warn("[YuMusic] failed to load autoplay tracks:", error);
		return [];
	}
}

/** The context a mix queue starts from — the artist header's "Mix" button. */
export interface MixSource {
	videoId: string;
	playlistId: string;
	params?: string;
}

/** The "Mix" context an artist page header carries, when it has one. */
export function artistMixSource(header: Artist["header"]): MixSource | null {
	const button =
		header instanceof YTNodes.MusicImmersiveHeader
			? header.start_radio_button
			: null;
	const payload = button?.endpoint?.payload as
		| { videoId?: string; playlistId?: string; params?: string }
		| undefined;
	if (!payload?.videoId || !payload.playlistId) return null;
	return {
		videoId: payload.videoId,
		playlistId: payload.playlistId,
		params: payload.params,
	};
}

/**
 * Tracks of an artist mix started from its source context. The mix context
 * feeds the queue endpoint; returns `[]` when the queue cannot be loaded.
 */
export async function getMixSongs(mix: MixSource): Promise<AutoplayTrack[]> {
	try {
		const client = await getYoutubeClient();
		const response = await client.actions.execute("/next", {
			videoId: mix.videoId,
			playlistId: mix.playlistId,
			params: mix.params,
			enablePersistentPlaylistPanel: true,
			client: "YTMUSIC",
			parse: true,
		});
		const tab = response.contents_memo?.getType(YTNodes.Tab)?.[0];
		const queue = tab?.content?.is(YTNodes.MusicQueue) ? tab.content : null;
		const panel = queue?.content;
		return panel ? panelTracks(panel) : [];
	} catch (error) {
		console.warn("[YuMusic] failed to load mix queue:", error);
		return [];
	}
}

/**
 * Starts an artist's "Mix" (radio) by id. The mix context lives on the artist
 * page's header button (`RDEM…` playlist id plus seed) and cannot be derived
 * from the channel id — hence one artist fetch, paid only on demand. Callers
 * that already hold the artist page (the artist view) should use
 * `artistMixSource` + `getMixSongs` instead.
 */
export async function getArtistMixSongs(
	artistId: string,
): Promise<AutoplayTrack[]> {
	try {
		const client = await getYoutubeClient();
		const artist = await client.music.getArtist(artistId);
		const mix = artistMixSource(artist.header);
		return mix ? await getMixSongs(mix) : [];
	} catch (error) {
		console.warn("[YuMusic] failed to start artist mix:", error);
		return [];
	}
}

export interface SongLyrics {
	/** Synced lyrics with per-line start times in seconds. */
	synced: LrcLine[] | null;
	/** Static lyrics text. */
	plain: string | null;
}

export async function getSongLyrics(videoId: string): Promise<SongLyrics> {
	const client = await getYoutubeClient();
	try {
		// Synced: browse the lyrics page with the iOS Music client context,
		// which is the only client that returns the timed-lyrics component.
		const browseId = await getLyricsBrowseId(client, videoId);
		if (browseId) {
			const synced = await fetchTimedLyrics(browseId);
			if (synced && synced.length > 0) {
				return { synced, plain: null };
			}
		}
	} catch (error) {
		console.warn("Failed to get synced lyrics:", error);
	}
	try {
		// Unsynced fallback: plain description shelf (WEB_REMIX client).
		const shelf = await client.music.getLyrics(videoId);
		const text = shelf?.description?.toString();
		return {
			synced: null,
			plain: text && text.trim().length > 0 ? text : null,
		};
	} catch (error) {
		console.warn("Failed to get lyrics:", error);
		return { synced: null, plain: null };
	}
}

/** Finds the browse id of the track's lyrics page via the watch-next tabs. */
async function getLyricsBrowseId(
	client: Innertube,
	videoId: string,
): Promise<string | null> {
	const watchNextEndpoint = new YTNodes.NavigationEndpoint({
		watchNextEndpoint: { videoId },
	});
	const response = await watchNextEndpoint.call(client.actions, {
		client: "YTMUSIC",
		parse: true,
	});
	const tabs = response.contents_memo?.getType(YTNodes.Tab);
	const tab = tabs?.find(
		(t) =>
			t.endpoint.payload?.browseEndpointContextSupportedConfigs
				?.browseEndpointContextMusicConfig?.pageType ===
			"MUSIC_PAGE_TYPE_TRACK_LYRICS",
	);
	return tab?.endpoint.payload?.browseId ?? null;
}

// YouTube Music's iOS app client. Its browse responses are the only ones that
// include the timed-lyrics component with per-line cue ranges.
const IOS_MUSIC_CLIENT = { clientName: 26, clientVersion: "7.01.05" };

interface TimedLyricsLine {
	lyricLine: string;
	cueRange?: {
		startTimeMilliseconds: string;
		endTimeMilliseconds: string;
	};
}

interface TimedLyricsBrowseResponse {
	contents?: {
		elementRenderer?: {
			newElement?: {
				type?: {
					componentType?: {
						model?: {
							timedLyricsModel?: {
								lyricsData?: {
									timedLyricsData?: TimedLyricsLine[];
								};
							};
						};
					};
				};
			};
		};
	};
}

async function fetchTimedLyrics(browseId: string): Promise<LrcLine[] | null> {
	const response = await fetchFunction(
		"https://music.youtube.com/youtubei/v1/browse?prettyPrint=false",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-YouTube-Client-Name": String(IOS_MUSIC_CLIENT.clientName),
				"X-YouTube-Client-Version": IOS_MUSIC_CLIENT.clientVersion,
			},
			body: JSON.stringify({
				browseId,
				context: { client: IOS_MUSIC_CLIENT },
			}),
		},
	);
	if (!response.ok) return null;
	const data = (await response.json()) as TimedLyricsBrowseResponse;
	const cues =
		data.contents?.elementRenderer?.newElement?.type?.componentType?.model
			?.timedLyricsModel?.lyricsData?.timedLyricsData;
	if (!Array.isArray(cues) || cues[0]?.cueRange == null) return null;
	const lines = cues
		.map((cue) => ({
			time: Number(cue.cueRange?.startTimeMilliseconds) / 1000,
			text: cue.lyricLine.trim(),
		}))
		.filter((line) => Number.isFinite(line.time));
	// Time the intro before the first vocal line from the start of the track
	// so the silence indicator runs there too.
	if (lines.length > 0 && lines[0].time > 0.3) {
		lines.unshift({ time: 0, text: "" });
	}
	return lines;
}

const CONTINUATION_ATTEMPTS = 3;
const CONTINUATION_BACKOFF_MS = 400;

/**
 * Loads the next page of a playlist. Transient timeouts or throttling would
 * otherwise leave long playlists stuck half-loaded (and their cache marked
 * incomplete), so retry a couple of times with a small backoff.
 */
export async function loadPlaylistContinuation(playlist: Playlist) {
	if (!playlist.has_continuation) {
		return null;
	}
	for (let attempt = 1; attempt <= CONTINUATION_ATTEMPTS; attempt++) {
		try {
			return await playlist.getContinuation();
		} catch (error) {
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

/** Ids one bulk queue request takes; more than a search list holds anyway. */
const MAX_QUEUE_IDS = 50;

/** Pulls `videoId → length label` pairs out of a bulk queue response. */
function collectQueueLengths(node: unknown, out: Map<string, string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectQueueLengths(item, out);
		return;
	}
	if (!node || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	const panel = record.playlistPanelVideoRenderer as
		| { videoId?: string; lengthText?: { runs?: { text?: string }[] } }
		| undefined;
	const id = panel?.videoId;
	const text = panel?.lengthText?.runs?.[0]?.text;
	if (id && text) out.set(id, text);
	for (const value of Object.values(record)) collectQueueLengths(value, out);
}

/**
 * Length labels for a batch of tracks, from the bulk queue endpoint. The mixed
 * "All" search rows carry no length (their trailing column shows play counts
 * instead), so one call backfills every listed track at once.
 */
export async function getTrackDurations(
	videoIds: string[],
): Promise<Map<string, string>> {
	const durations = new Map<string, string>();
	if (videoIds.length === 0) return durations;
	const client = await getYoutubeClient();
	const response = await client.actions.execute("/music/get_queue", {
		videoIds: videoIds.slice(0, MAX_QUEUE_IDS),
		client: "YTMUSIC",
	});
	collectQueueLengths(response.data, durations);
	return durations;
}

/**
 * Search-bar completions YouTube Music suggests for a partial query. Returns
 * the query strings only, de-duplicated; failures resolve to an empty list so
 * typing never breaks when suggestions are unavailable.
 */
export async function getSearchCompletions(query: string): Promise<string[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	try {
		const client = await getYoutubeClient();
		const sections = await client.music.getSearchSuggestions(trimmed);
		const seen = new Set<string>();
		const suggestions: string[] = [];
		for (const section of sections) {
			for (const node of section.contents ?? []) {
				const text = (
					node as unknown as { suggestion?: { toString(): string } }
				).suggestion
					?.toString()
					.trim();
				if (!text) continue;
				const key = text.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				suggestions.push(text);
			}
		}
		return suggestions;
	} catch (error) {
		console.warn("[search] failed to load completions:", error);
		return [];
	}
}

export async function getSongStream(videoId: string) {
	const client = await getYoutubeClient();

	const visitorData = client.session.context.client.visitorData;
	if (!visitorData) {
		throw new Error("Missing visitor data");
	}

	// The /player endpoint rejects requests without a PoToken, so pass a
	// visitor-bound one here. Playback mints separate per-video tokens.
	await botguardService.init();
	const poToken = await botguardService.mintToken(visitorData);
	client.session.po_token = poToken;

	const playerResponse = await client.actions.execute("/player", {
		videoId,
		contentCheckOk: true,
		racyCheckOk: true,
		playbackContext: {
			contentPlaybackContext: {
				signatureTimestamp: client.session.player?.signature_timestamp,
			},
		},
		serviceIntegrityDimensions: {
			poToken,
		},
	});

	const cpn = Utils.generateRandomString(16);
	const info = new YT.VideoInfo([playerResponse], client.actions, cpn);

	// Return the full VideoInfo object for SABR streaming support
	return { videoInfo: info, innertube: client, poToken };
}

/**
 * Stream session for a track, preferring its song version: when YouTube Music
 * pairs a music video with an album track, the track is that song, so
 * playback, crossfade preloading and downloads all use the song's stream.
 * The video's own stream is fetched in parallel with the version lookup, so
 * tracks without a song version load exactly as before; when one exists, its
 * stream replaces the video's. `videoId` is the id actually streamed — the
 * Sabr session and its PoToken must use it, not the requested one.
 */
export async function getPlaybackStream(videoId: string) {
	const [version, fallback] = await Promise.allSettled([
		getSongVersion(videoId),
		getSongStream(videoId),
	]);
	const songVersion = version.status === "fulfilled" ? version.value : null;
	if (songVersion && songVersion.id !== videoId) {
		try {
			const result = await getSongStream(songVersion.id);
			// An unplayable version (region blocks) has no stream to feed the
			// player, so it must not replace a working video.
			if (result.videoInfo.streaming_data) {
				console.log(
					`[YuMusic] playing the song version ${songVersion.id} (video: ${videoId})`,
				);
				return { ...result, videoId: songVersion.id };
			}
			console.warn(
				"[YuMusic] song version has no stream, playing the original video",
			);
		} catch (error) {
			console.warn(
				"[YuMusic] song version unavailable, playing the original video:",
				error,
			);
		}
	}
	if (fallback.status === "fulfilled") return { ...fallback.value, videoId };
	throw fallback.reason;
}

/**
 * The album-track version of the video, when YouTube Music pairs one. Read
 * from the Up Next queue that the track metadata already fetches, so it
 * shares the per-track cache; resolves to null when the video has no version
 * (or the queue is unavailable).
 */
export async function getSongVersion(
	videoId: string,
): Promise<SongVersion | null> {
	const meta = await getTrackMeta(videoId).catch(() => null);
	return meta?.songVersion ?? null;
}

export interface TrackMeta {
	album?: { name: string; id?: string };
	artists: { name: string; id?: string }[];
	/** Uploader's original title, from the public oEmbed endpoint. */
	originalTitle?: string;
	/** Primary artist credit, in the session's fetch language. */
	originalArtist?: string;
	/** Audio-track ("song") version of a music video, when the queue has one. */
	songVersion?: SongVersion;
}

/**
 * Session cache for queue metadata: it is locale-stable and costs a queue
 * fetch, so a track played, scrobbled and enriched only fetches it once.
 */
const trackMetaCache = new LruCache<string, TrackMeta>(256);
const trackMetaRequests = new Map<string, Promise<TrackMeta | null>>();

/**
 * Album and artist metadata for a track, taken from the selected entry of the
 * "Up next" queue (fetched in the app's current language). The original title
 * comes from oEmbed, which is locale-independent; failures resolve to null so
 * callers keep working without it.
 */
export function getTrackMeta(videoId: string): Promise<TrackMeta | null> {
	const known = trackMetaCache.get(videoId);
	if (known) return Promise.resolve(known);
	const pending = trackMetaRequests.get(videoId);
	if (pending) return pending;
	const request = fetchTrackMeta(videoId)
		.then((meta) => {
			if (meta) trackMetaCache.set(videoId, meta);
			return meta;
		})
		.finally(() => trackMetaRequests.delete(videoId));
	trackMetaRequests.set(videoId, request);
	return request;
}

/** The song-version metadata the queue's counterpart entry carries. */
function toSongVersion(entry: YTNodes.PlaylistPanelVideo): SongVersion {
	const artists = (entry.artists ?? [])
		.filter((artist) => artist.name)
		.map((artist) => ({
			name: artist.name,
			id: artist.channel_id?.startsWith("UC") ? artist.channel_id : undefined,
		}));
	return {
		id: entry.video_id,
		title: entry.title?.toString() || undefined,
		artists: artists.length > 0 ? artists : undefined,
		duration: entry.duration?.text || undefined,
		thumbnail: hiResThumb(biggestThumb(entry.thumbnail)?.url) || undefined,
		album: entry.album
			? { name: entry.album.name, id: entry.album.id }
			: undefined,
	};
}

async function fetchTrackMeta(videoId: string): Promise<TrackMeta | null> {
	try {
		const client = await getYoutubeClient();
		const info = await client.music.getInfo(videoId);
		const queue = await info.getUpNext(false);
		const videos: YTNodes.PlaylistPanelVideo[] = [];
		const wrappers: YTNodes.PlaylistPanelVideoWrapper[] = [];
		for (const item of queue.contents) {
			if (item.is(YTNodes.PlaylistPanelVideo)) {
				videos.push(item);
			} else if (item.is(YTNodes.PlaylistPanelVideoWrapper) && item.primary) {
				videos.push(item.primary);
				wrappers.push(item);
			}
		}
		const current =
			videos.find((video) => video.selected) ??
			videos.find((video) => video.video_id === videoId);
		if (!current) return null;
		const versionEntry = songVersionEntryFromQueue(wrappers, videoId);
		const oembed = await getOembedMetadata(videoId, (input, init) =>
			fetchFunction(input, init),
		);
		return {
			album: current.album
				? { name: current.album.name, id: current.album.id }
				: undefined,
			artists: (current.artists ?? [])
				.filter((artist) => artist.name)
				.map((artist) => ({
					name: artist.name,
					id: artist.channel_id?.startsWith("UC")
						? artist.channel_id
						: undefined,
				})),
			originalTitle: oembed?.title ?? undefined,
			originalArtist: current.artists?.[0]?.name || undefined,
			songVersion: versionEntry ? toSongVersion(versionEntry) : undefined,
		};
	} catch (error) {
		console.warn("[YuMusic] failed to load track metadata:", error);
		return null;
	}
}
