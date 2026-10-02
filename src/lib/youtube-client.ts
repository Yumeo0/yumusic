import {
	Innertube,
	Platform,
	type Types,
	UniversalCache,
	Utils,
	YT,
	YTNodes,
} from "youtubei.js/web";
import { botguardService } from "./botguard-service";
import type { LrcLine } from "./lrclib";
import { getOembedMetadata } from "./oembed";
import { NEEDS_BODY_HEADER, PROXY_ORIGIN } from "./tauri";

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

	try {
		// Add a timeout to prevent indefinite hangs
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			console.error("[fetchFunction] Request timed out after 30 seconds");
			controller.abort();
		}, 30000);

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
			signal: controller.signal,
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

export type Album = Awaited<ReturnType<Innertube["music"]["getAlbum"]>>;

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

export async function loadPlaylistContinuation(playlist: Playlist) {
	if (!playlist.has_continuation) {
		return null;
	}
	try {
		const continuation = await playlist.getContinuation();
		return continuation;
	} catch (error) {
		console.error("Failed to load playlist continuation:", error);
		return null;
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

export interface TrackMeta {
	album?: { name: string; id?: string };
	artists: { name: string; id?: string }[];
	/** Uploader's original title, from the public oEmbed endpoint. */
	originalTitle?: string;
	/** Primary artist credit, in the session's fetch language. */
	originalArtist?: string;
}

/**
 * Album and artist metadata for a track, taken from the selected entry of the
 * "Up next" queue (fetched in the app's current language). The original title
 * comes from oEmbed, which is locale-independent; failures resolve to null so
 * callers keep working without it.
 */
export async function getTrackMeta(videoId: string): Promise<TrackMeta | null> {
	try {
		const client = await getYoutubeClient();
		const info = await client.music.getInfo(videoId);
		const queue = await info.getUpNext(false);
		const videos: YTNodes.PlaylistPanelVideo[] = [];
		for (const item of queue.contents) {
			if (item.is(YTNodes.PlaylistPanelVideo)) {
				videos.push(item);
			} else if (item.is(YTNodes.PlaylistPanelVideoWrapper) && item.primary) {
				videos.push(item.primary);
			}
		}
		const current =
			videos.find((video) => video.selected) ??
			videos.find((video) => video.video_id === videoId);
		if (!current) return null;
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
		};
	} catch (error) {
		console.warn("[YuMusic] failed to load track metadata:", error);
		return null;
	}
}
