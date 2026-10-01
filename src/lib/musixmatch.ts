import type { LrcLine } from "./lrclib";
import { fetchFunction } from "./youtube-client";

/**
 * Musixmatch provider using the mobile-app API (`apic-appmobile`), which —
 * unlike the desktop endpoint (whose `track.search` returns a canned,
 * query-independent result) — returns real data. This mirrors how Spicetify's
 * lyrics-plus does it: the iOS app headers plus a real user token from
 * `token.get`, then one `macro.subtitles.get` call that resolves and returns
 * the lyrics in a single round trip.
 *
 * Requests go through the app's Tauri proxy (`fetchFunction`) because the
 * endpoint needs custom headers and sends no CORS headers for a webview.
 */
const ROOT = "https://apic-appmobile.musixmatch.com/ws/1.1/";
const APP_ID = "mac-ios-v2.0";
const HEADERS: Record<string, string> = {
	// Explicit empty cookie so the Tauri proxy doesn't attach the user's
	// YouTube cookies to these third-party Musixmatch requests.
	Cookie: "",
	"X-Cookie": "x-mxm-token-guid=",
	"x-mxm-app-version": "10.1.1",
	"X-User-Agent": "Musixmatch/2025120901 CFNetwork/3860.300.31 Darwin/25.2.0",
	"Accept-Language": "en-US,en;q=0.9",
	Accept: "application/json",
};

/** Strips noise YouTube appends to titles (shared with the LRCLIB fetcher). */
function cleanTitle(title: string): string {
	return title
		.replace(/[([{][^)\]}]*[)\]}]/g, "")
		.replace(/\s*feat\..*$/i, "")
		.trim();
}

let tokenPromise: Promise<string | null> | null = null;

function getToken(): Promise<string | null> {
	if (!tokenPromise) {
		tokenPromise = (async () => {
			try {
				const res = await fetchFunction(
					`${ROOT}token.get?app_id=${APP_ID}&format=json`,
					{ headers: HEADERS },
				);
				const data = (await res.json()) as {
					message?: { body?: { user_token?: string } };
				};
				return data.message?.body?.user_token || null;
			} catch {
				return null;
			}
		})();
	}
	return tokenPromise;
}

async function mget(
	action: string,
	params: Record<string, string>,
): Promise<unknown> {
	const token = await getToken();
	const query = new URLSearchParams({
		format: "json",
		...params,
		app_id: APP_ID,
	});
	if (token) query.set("usertoken", token);
	const res = await fetchFunction(`${ROOT}${action}?${query}`, {
		headers: HEADERS,
	});
	return res.json();
}

interface MxmTrack {
	track_id?: number;
	track_name?: string;
	artist_name?: string;
	instrumental?: number;
	has_subtitles?: number;
	has_richsync?: number;
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** True when one normalized string contains the other, or they overlap enough. */
function fieldMatches(
	candidate: string,
	wanted: string,
	minCoverage: number,
): boolean {
	const c = normalize(candidate);
	const w = normalize(wanted);
	if (!c || !w) return false;
	if (c === w || c.includes(w) || w.includes(c)) return true;
	const have = new Set(c.split(" ").filter(Boolean));
	const want = w.split(" ").filter(Boolean);
	if (want.length === 0) return false;
	return (
		want.filter((token) => have.has(token)).length / want.length >= minCoverage
	);
}

const LRC_TIME = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parses Musixmatch's `subtitle_format=mxm` body (JSON) into timed lines. */
function parseMxmSubtitle(body: string): LrcLine[] {
	try {
		const parsed = JSON.parse(body) as Array<{
			text?: string;
			time?: { total?: number };
		}>;
		if (Array.isArray(parsed)) {
			return parsed
				.map((line) => ({
					time: Number(line.time?.total ?? 0),
					text: String(line.text ?? "").trim(),
				}))
				.filter((line) => line.text && line.time > 0)
				.sort((a, b) => a.time - b.time);
		}
	} catch {
		// not JSON — fall through to LRC parsing
	}
	return parseLrc(body);
}

/** Parses classic LRC ("[00:12.34] line") — some responses use this format. */
function parseLrc(body: string): LrcLine[] {
	const lines: LrcLine[] = [];
	for (const raw of body.split("\n")) {
		const stamps = [...raw.matchAll(LRC_TIME)];
		if (stamps.length === 0) continue;
		const text = raw.replace(LRC_TIME, "").trim();
		if (!text) continue;
		for (const stamp of stamps) {
			const minutes = Number.parseInt(stamp[1], 10);
			const seconds = Number.parseInt(stamp[2], 10);
			const frac = stamp[3] ? Number.parseInt(stamp[3].padEnd(3, "0"), 10) : 0;
			lines.push({ time: minutes * 60 + seconds + frac / 1000, text });
		}
	}
	return lines.sort((a, b) => a.time - b.time);
}

/** Collapses Musixmatch word-level richsync JSON into one entry per line. */
function parseRichsync(body: string): LrcLine[] {
	try {
		const parsed = JSON.parse(body) as Array<{
			ts?: string;
			l?: Array<{ c?: string }>;
		}>;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((line) => ({
				time: Number.parseFloat(line.ts ?? ""),
				text: (line.l ?? [])
					.map((word) => word.c ?? "")
					.join("")
					.trim(),
			}))
			.filter((line) => line.text && Number.isFinite(line.time))
			.sort((a, b) => a.time - b.time);
	} catch {
		return [];
	}
}

interface MacroCalls {
	[key: string]: {
		message?: {
			header?: { status_code?: number };
			body?: {
				track?: MxmTrack;
				subtitle_list?: Array<{
					subtitle?: { subtitle_body?: string };
				}>;
				richsync?: { richsync_body?: string };
			};
		};
	};
}

/**
 * Fetches time-synced lyrics from Musixmatch via its mobile macro endpoint.
 * The endpoint resolves the track itself from the query, so we validate the
 * resolved track against the request to avoid returning the wrong song's
 * lyrics. Returns null when nothing usable matches.
 */
export async function fetchMusixmatchSynced(
	title: string,
	artist: string,
	durationSec = 0,
): Promise<LrcLine[] | null> {
	const track = cleanTitle(title);
	if (!track || !artist.trim()) return null;

	try {
		const params: Record<string, string> = {
			namespace: "lyrics_richsynched",
			subtitle_format: "mxm",
			q_track: track,
			q_artist: artist,
			optional_calls: "track.richsync",
			richsync_compact_type: "words",
		};
		if (durationSec > 0) {
			params.q_duration = String(Math.round(durationSec));
			params.f_subtitle_length = String(Math.floor(durationSec));
		}

		const data = (await mget("macro.subtitles.get", params)) as {
			message?: { body?: { macro_calls?: MacroCalls } };
		};
		const calls = data?.message?.body?.macro_calls;
		if (!calls) return null;

		const matcher = calls["matcher.track.get"]?.message;
		if (matcher?.header?.status_code !== 200) return null;
		const resolved = matcher.body?.track;
		if (!resolved) return null;
		if (resolved.instrumental) return null;

		// Guard against a mismatched resolution (obscure titles, remixes…).
		if (resolved.track_name && !fieldMatches(resolved.track_name, track, 0.6)) {
			return null;
		}
		if (
			resolved.artist_name &&
			!fieldMatches(resolved.artist_name, artist, 0.4)
		) {
			return null;
		}

		const subtitleBody =
			calls["track.subtitles.get"]?.message?.body?.subtitle_list?.[0]?.subtitle
				?.subtitle_body;
		if (subtitleBody) {
			const lines = parseMxmSubtitle(subtitleBody);
			if (lines.length > 0) return lines;
		}

		const richsyncBody =
			calls["track.richsync.get"]?.message?.body?.richsync?.richsync_body;
		if (richsyncBody) {
			const lines = parseRichsync(richsyncBody);
			if (lines.length > 0) return lines;
		}

		return null;
	} catch (error) {
		console.warn("[musixmatch] failed to fetch lyrics:", error);
		return null;
	}
}
