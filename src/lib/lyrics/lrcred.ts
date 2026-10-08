import { proxiedFetch, USER_AGENT } from "../utils/tauri";
import { cleanSearchTitle, formatTitleParts } from "../utils/title";
import type { LrcLine, LrcWord } from "./lrclib";
import { lyricsKind } from "./lyrics-providers";

/**
 * lrc.red — a public lyrics archive with hand-timed and model-word-synced
 * lyrics. The free JSON API (https://lrc.red) is searched by track + artist —
 * for dual titles both the original and the translated half — and the
 * matched track's song payload is fetched by ISRC; timings come back in
 * seconds, and word-synced lines carry their words as timed character
 * segments. Untimed and line-level tracks are word-aligned on demand through
 * lrc.red's /sync endpoint. Requests go through the app's Tauri proxy so they
 * carry the app's User-Agent.
 */

const BASE = "https://lrc.red";

/** The alignment model runs take a few seconds; fall back to plain past this. */
const SYNC_TIMEOUT_MS = 30_000;

export interface LrcRedLyrics {
	synced: LrcLine[] | null;
	plain: string | null;
	/** Matched on artist + title (or authoritative), not a loose match. */
	confirmed: boolean;
}

interface LrcRedHit {
	isrc?: string;
	title?: string;
	artist?: string;
	album?: string;
	duration?: number;
}

/** One timed character segment of a word (times are seconds). */
interface LrcRedSegment {
	begin?: number;
	end?: number;
	text?: string;
}

/** One entry of a song's lyrics: its text and, on word-synced lines, words. */
interface LrcRedSongLine {
	begin?: number;
	end?: number;
	text?: string;
	/** Marks lines carrying real word-level timing. */
	timed?: boolean;
	/** Word chunks, each holding its timed character segments. */
	words?: LrcRedSegment[][] | null;
}

interface LrcRedSong {
	/** "word" | "line" | "none" — the richest timing the track has. */
	level?: string;
	lyrics?: { lines?: LrcRedSongLine[] | null } | null;
}

/** Track metadata; its `sync` field reports the live timing level. */
interface LrcRedInfo {
	sync?: string;
}

/** Timing levels, richest last; unknown values rank below every level. */
const LEVEL_RANKS: Record<string, number> = { none: 0, line: 1, word: 2 };

function levelRank(level: string | undefined): number {
	if (typeof level !== "string") return -1;
	return LEVEL_RANKS[level] ?? -1;
}

/** A finite number, or null — the payload uses null for "missing". */
function toSeconds(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Collapses whitespace for text comparisons and display. */
function fold(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Parses a line's word chunks into per-word timings. Chunks arrive without
 * the line's spaces (each chunk is a word made of character segments), so
 * single spaces are re-attached between them — unless the chunks already
 * concatenate back to the line verbatim, which is how space-less scripts
 * (Japanese and friends) arrive.
 */
function parseWords(
	cells: LrcRedSegment[][] | null | undefined,
	lineText: string,
): LrcWord[] | undefined {
	if (!Array.isArray(cells)) return undefined;
	const chunks: LrcWord[] = [];
	for (const cell of cells) {
		let text = "";
		let time: number | null = null;
		let end: number | undefined;
		for (const segment of Array.isArray(cell) ? cell : []) {
			text += segment?.text ?? "";
			time ??= toSeconds(segment?.begin);
			end = toSeconds(segment?.end) ?? end;
		}
		if (text.trim() === "" || time === null) continue;
		chunks.push(
			end !== undefined && end > time ? { time, end, text } : { time, text },
		);
	}
	if (chunks.length === 0) return undefined;
	if (chunks.length > 1) {
		const compact = fold(chunks.map((chunk) => chunk.text).join(""));
		if (compact !== fold(lineText)) {
			for (let i = 0; i < chunks.length - 1; i++) {
				chunks[i] = { ...chunks[i], text: `${chunks[i].text.trimEnd()} ` };
			}
		}
	}
	return chunks;
}

/**
 * Maps a song payload onto the panel's lyrics shape. Timed lines become
 * synced lines (word payloads carry per-word timings); payloads whose lines
 * have no usable times — untimed tracks carry every line at 0:00 — become
 * plain text. Returns null when the payload carries no lyric text.
 */
export function parseLrcRedSong(
	song: LrcRedSong,
): Omit<LrcRedLyrics, "confirmed"> | null {
	const raw = Array.isArray(song.lyrics?.lines) ? song.lyrics.lines : [];
	const lines = raw
		.map((line) => {
			const text = fold(line.text ?? "");
			return {
				time: toSeconds(line.begin),
				text,
				words: line.timed ? parseWords(line.words, text) : undefined,
			};
		})
		.filter((line) => line.text.length > 0);
	if (lines.length === 0) return null;

	const timed = lines.filter(
		(line): line is typeof line & { time: number } =>
			line.time !== null && line.time > 0,
	);
	if (timed.length === 0) {
		return { synced: null, plain: lines.map((line) => line.text).join("\n") };
	}
	timed.sort((a, b) => a.time - b.time);
	return {
		synced: timed.map(({ time, text, words }) =>
			words ? { time, text, words } : { time, text },
		),
		plain: null,
	};
}

async function search(query: string): Promise<LrcRedHit[]> {
	try {
		const params = new URLSearchParams({ q: query });
		const res = await proxiedFetch(`${BASE}/search.json?${params}`, {
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		});
		if (!res.ok) {
			console.warn(`[lrc.red] search responded ${res.status}`);
			return [];
		}
		const data = (await res.json()) as { hits?: LrcRedHit[] | null };
		return Array.isArray(data.hits) ? data.hits : [];
	} catch (error) {
		console.warn("[lrc.red] search failed:", error);
		return [];
	}
}

/**
 * Fetches a track's song payload. The CDN caches it for a day; `fresh` adds a
 * throwaway parameter that bypasses the cache, for when the cached copy may
 * predate a word sync.
 */
async function fetchSong(
	isrc: string,
	fresh: boolean,
): Promise<LrcRedSong | null> {
	try {
		const url = `${BASE}/s/${encodeURIComponent(isrc)}.song.json${
			fresh ? `?v=${Date.now()}` : ""
		}`;
		const res = await proxiedFetch(url, {
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		});
		if (!res.ok) {
			console.warn(`[lrc.red] song ${isrc} responded ${res.status}`);
			return null;
		}
		return (await res.json()) as LrcRedSong;
	} catch (error) {
		console.warn(`[lrc.red] song ${isrc} request failed:`, error);
		return null;
	}
}

/** Fetches a track's metadata; its `sync` level is fresher than the cache. */
async function fetchInfo(isrc: string): Promise<LrcRedInfo | null> {
	try {
		const res = await proxiedFetch(
			`${BASE}/s/${encodeURIComponent(isrc)}.json`,
			{ Accept: "application/json", "User-Agent": USER_AGENT },
		);
		if (!res.ok) return null;
		return (await res.json()) as LrcRedInfo;
	} catch (error) {
		console.warn(`[lrc.red] metadata for ${isrc} request failed:`, error);
		return null;
	}
}

/** In-flight alignment runs, keyed by ISRC. */
const syncRequests = new Map<string, Promise<LrcRedSong | null>>();

/**
 * Asks lrc.red's in-house model to word-align an untimed track
 * (`POST /s/<isrc>/sync`) and returns the aligned song payload, or null when
 * it fails. The model run takes a few seconds, hence the timeout — callers
 * fall back to the untimed payload. Concurrent lookups of the same track
 * share one request so the model isn't run twice.
 */
function syncSong(isrc: string): Promise<LrcRedSong | null> {
	const existing = syncRequests.get(isrc);
	if (existing) return existing;
	const request = requestSync(isrc).finally(() => syncRequests.delete(isrc));
	syncRequests.set(isrc, request);
	return request;
}

async function requestSync(isrc: string): Promise<LrcRedSong | null> {
	try {
		const res = await proxiedFetch(
			`${BASE}/s/${encodeURIComponent(isrc)}/sync`,
			{ Accept: "application/json", "User-Agent": USER_AGENT },
			{ method: "POST", signal: AbortSignal.timeout(SYNC_TIMEOUT_MS) },
		);
		if (!res.ok) {
			console.warn(`[lrc.red] sync ${isrc} responded ${res.status}`);
			return null;
		}
		return (await res.json()) as LrcRedSong;
	} catch (error) {
		console.warn(`[lrc.red] sync ${isrc} failed:`, error);
		return null;
	}
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

/** Confirmed (artist+title) matches may drift by this much. */
const DURATION_TOLERANCE_SEC = 5;
/** Title-only (loose) matches are only accepted this close. */
const LOOSE_DURATION_TOLERANCE_SEC = 3;

/** Closest hit by track duration, or null when none is within tolerance. */
function closestWithin(
	hits: LrcRedHit[],
	durationSec: number,
	tolerance: number,
): LrcRedHit | null {
	if (hits.length === 0) return null;
	// Without a known duration, trust the search's relevance order.
	if (durationSec <= 0) return hits[0];
	let best: LrcRedHit | null = null;
	let bestDelta = Number.POSITIVE_INFINITY;
	for (const hit of hits) {
		if (typeof hit.duration !== "number" || !Number.isFinite(hit.duration)) {
			continue;
		}
		const delta = Math.abs(hit.duration - durationSec);
		if (delta <= tolerance && delta < bestDelta) {
			best = hit;
			bestDelta = delta;
		}
	}
	return best;
}

/**
 * Picks the hit to fetch: a hit whose title matches any searched title plus
 * the artist is confirmed; a title-only match with a near duration is loose —
 * same two-tier matching the LRCLIB provider uses, so cover versions can't
 * silently win on relevance alone.
 */
function pickHit(
	hits: LrcRedHit[],
	tracks: readonly string[],
	artist: string,
	durationSec: number,
): { hit: LrcRedHit; confirmed: boolean } | null {
	const usable = hits.filter((hit) => hit.isrc && hit.title);
	const titleMatches = (hit: LrcRedHit) =>
		tracks.some((track) => fieldMatches(hit.title ?? "", track, 0.6));
	const confirmed = closestWithin(
		usable.filter(
			(hit) => titleMatches(hit) && fieldMatches(hit.artist ?? "", artist, 0.4),
		),
		durationSec,
		DURATION_TOLERANCE_SEC,
	);
	if (confirmed) return { hit: confirmed, confirmed: true };
	const loose = closestWithin(
		usable.filter(titleMatches),
		durationSec,
		LOOSE_DURATION_TOLERANCE_SEC,
	);
	return loose ? { hit: loose, confirmed: false } : null;
}

/**
 * Fetches lyrics from lrc.red: searches with the app's cleaned title plus
 * artist — and, for "Original - Translation" dual titles, the translated
 * half too — picks the closest-duration hit, then loads the track's song
 * payload. When the CDN-cached payload trails the track's metadata level
 * (recently word-synced tracks), the payload is refetched past the cache so
 * the word-level sync isn't missed; untimed and line-level tracks are
 * word-aligned on demand through the /sync endpoint. Returns null when
 * nothing usable matches.
 */
export async function fetchLrcRedLyrics(
	title: string,
	artist: string,
	durationSec = 0,
): Promise<LrcRedLyrics | null> {
	const original = cleanSearchTitle(title, artist).trim();
	// Dual titles clean down to their original side; the translation side is
	// searched as well so a track filed under its translated name still
	// matches. Pool order stays original-first, which is also the duration-
	// tie-break order.
	const translated = formatTitleParts(
		title,
		"translation",
		true,
		artist,
	).main.trim();
	const name = artist.trim();
	if (!original || !name) return null;
	const tracks =
		translated && translated !== original ? [original, translated] : [original];

	const pools = await Promise.all(
		tracks.map((track) => search(`${track} ${name}`)),
	);
	const picked = pickHit(pools.flat(), tracks, name, durationSec);
	const isrc = picked?.hit.isrc;
	if (!picked || !isrc) return null;

	let song = await fetchSong(isrc, false);
	if (!song) return null;

	// song.json sits in the CDN cache for a day, so a track that was
	// word-synced after the cache filled still reads as line-level. The
	// (fresher) metadata says which level the track really has: when it is
	// richer, refetch the payload past the cache.
	const cachedRank = levelRank(song.level);
	if (cachedRank < LEVEL_RANKS.word) {
		const info = await fetchInfo(isrc);
		if (info && levelRank(info.sync) > cachedRank) {
			song = (await fetchSong(isrc, true)) ?? song;
		}
	}

	const parsed = parseLrcRedSong(song);
	if (!parsed) return null;

	// Plain payloads carry no timing at all, and line-level ones miss the
	// karaoke word fill; lrc.red can word-align either with their in-house
	// model on demand. A result is only used when it improves on the fetched
	// payload — any timing for plain, word timing for line-level — and the
	// fetched payload is kept when the sync fails or comes back untimed.
	let lyrics = parsed;
	if (lyricsKind(lyrics) !== "word") {
		const synced = await syncSong(isrc);
		const syncedParsed = synced ? parseLrcRedSong(synced) : null;
		if (
			syncedParsed?.synced &&
			(lyricsKind(syncedParsed) === "word" || parsed.synced === null)
		) {
			lyrics = syncedParsed;
		}
	}
	return { ...lyrics, confirmed: picked.confirmed };
}
