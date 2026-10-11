/**
 * ListenBrainz scrobbling with MusicBrainz track lookup: recordings are
 * searched on MusicBrainz first so the submitted listen carries the
 * recording MBID and ListenBrainz doesn't have to match it itself. The
 * artist is resolved on MusicBrainz first, because the queue's credit is
 * often a romanization/alias ("Sakamata Chloe") that the recording's artist
 * credit doesn't carry ("沙花叉クロヱ").
 */

const LB_API = "https://api.listenbrainz.org/1";
const MB_API = "https://musicbrainz.org/ws/2";
const MBID_CACHE_KEY = "yumusic:mbids";
const ARTIST_CACHE_KEY = "yumusic:mb-artists";
const CACHE_MAX = 200;

export interface RecordingMbids {
	recording: string;
	artists?: string[];
	release?: string;
}

export interface ListenPayload {
	token: string;
	trackName: string;
	artistName: string;
	album?: string;
	mbids?: RecordingMbids | null;
	/** Unix seconds — omitted for "playing now" listens. */
	listenedAt?: number;
}

const memoryCache = new Map<string, RecordingMbids | null>();
/** Session-scoped negative cache so failed lookups aren't hammered. */
const failedLookups = new Set<string>();

function readCache<T>(key: string): Record<string, T> {
	try {
		return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, T>;
	} catch {
		return {};
	}
}

function writeCache<T>(key: string, cache: Record<string, T>) {
	try {
		const entries = Object.entries(cache).slice(-CACHE_MAX);
		localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
	} catch {
		// storage unavailable — memory cache still applies
	}
}

interface MbRecording {
	id: string;
	title?: string;
	length?: number;
	"artist-credit"?: Array<{
		name?: string;
		artist?: { id?: string; name?: string };
	}>;
	releases?: Array<{ id: string }>;
}

let mbQueue: Promise<unknown> = Promise.resolve();
const MB_SPACING_MS = 1100;
const MB_RETRY_LIMIT = 1;

/** HTTP-level MusicBrainz failure, carrying the status for retry decisions. */
class MbRequestError extends Error {
	status: number;
	constructor(status: number) {
		super(`MusicBrainz ${status}`);
		this.status = status;
	}
}

/**
 * MusicBrainz allows ~1 request/second — serialize with 1.1s spacing. The
 * search server reports load with 503/429; one spaced retry usually gets
 * through, while 4xx query errors are final.
 */
function mbRequest<T>(url: string, attempt = 0): Promise<T> {
	const run = mbQueue.then(async () => {
		const res = await fetch(url);
		if (!res.ok) throw new MbRequestError(res.status);
		return (await res.json()) as T;
	});
	mbQueue = run.then(
		() => new Promise((resolve) => setTimeout(resolve, MB_SPACING_MS)),
		() => new Promise((resolve) => setTimeout(resolve, MB_SPACING_MS)),
	);
	return run.catch((error) => {
		const retriable =
			!(error instanceof MbRequestError) ||
			error.status === 429 ||
			error.status >= 500;
		if (retriable && attempt < MB_RETRY_LIMIT) {
			return mbRequest<T>(url, attempt + 1);
		}
		throw error;
	});
}

/** MusicBrainz artist search hit (fields used here). */
interface MbArtist {
	name?: string;
	"sort-name"?: string;
	score?: number;
	aliases?: Array<{ name?: string }>;
}

const artistMemoryCache = new Map<string, string | null>();
/** Session-scoped negative cache for artist searches without a hit. */
const artistFailures = new Set<string>();

/** Folds a name for comparison: lowercase, no spaces, punctuation or symbols. */
function foldName(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * Token signature of a name: lowercase words, sorted — so word order and
 * punctuation don't matter ("Nakuru Aitsuki" ≡ "Aitsuki, Nakuru").
 */
function tokenKey(text: string): string {
	return text
		.split(/[\s\p{P}\p{S}]+/u)
		.map((token) => token.toLowerCase())
		.filter(Boolean)
		.sort()
		.join(" ");
}

/** Whether a hit carries the searched name as its name, sort name or alias. */
function artistMatches(
	artist: MbArtist,
	folded: string,
	tokens: string,
): boolean {
	const names = [
		artist.name,
		artist["sort-name"],
		...(artist.aliases ?? []).map((alias) => alias.name),
	];
	return names.some(
		(name) =>
			name !== undefined &&
			(foldName(name) === folded || tokenKey(name) === tokens),
	);
}

/**
 * Resolves the name MusicBrainz credits an artist under. The queue's credit
 * is often a romanization or alias ("Sakamata Chloe") while recording credits
 * carry the original-language name ("沙花叉クロヱ"), and the recording query's
 * `artist:` field only matches the credit. A hit counts when the searched
 * name equals the artist's name, sort name or an alias — word order and
 * punctuation ignored, so "Nakuru Aitsuki" matches the alias "Aitsuki
 * Nakuru" — so an unrelated top result can't redirect the recording search.
 * Results are cached in localStorage; resolves to null when nothing matches.
 */
async function findArtistName(artistName: string): Promise<string | null> {
	const folded = foldName(artistName);
	if (folded === "") return null;
	const tokens = tokenKey(artistName);
	const memory = artistMemoryCache.get(folded);
	if (memory !== undefined) return memory;
	if (artistFailures.has(folded)) return null;
	const stored = readCache<string>(ARTIST_CACHE_KEY)[folded];
	if (stored) {
		artistMemoryCache.set(folded, stored);
		return stored;
	}
	const data = await mbRequest<{ artists?: MbArtist[] }>(
		`${MB_API}/artist?query=${encodeURIComponent(artistName)}&fmt=json&limit=5`,
	);
	let pick: MbArtist | undefined;
	let bestScore = -Number.MAX_SAFE_INTEGER;
	for (const artist of data.artists ?? []) {
		if (!artistMatches(artist, folded, tokens)) continue;
		const score = artist.score ?? 0;
		if (score > bestScore) {
			bestScore = score;
			pick = artist;
		}
	}
	const name = pick?.name?.trim() || null;
	if (!name) {
		artistMemoryCache.set(folded, null);
		artistFailures.add(folded);
		return null;
	}
	artistMemoryCache.set(folded, name);
	const cache = readCache<string>(ARTIST_CACHE_KEY);
	cache[folded] = name;
	writeCache(ARTIST_CACHE_KEY, cache);
	return name;
}

/** Penalize instrumental/karaoke-style qualifiers when the query lacks them. */
const VERSION_QUALIFIER =
	/\b(?:instrumental|off\s?vocal|offvocal|karaoke|acapella|a\s?cappella|backing\s?track|tv\s?size|tv\s?ver(?:sion)?|game\s?ver(?:sion)?|movie\s?ver(?:sion)?|short\s?ver(?:sion)?|remix|cover)\b/i;

/**
 * Whether the recording's artist credit names one of the wanted artists.
 * Wanted names are split ("A & B", "A, B") and compared folded, so spacing
 * and punctuation differences ("加猫 のか" / "加猫のか") don't matter, and a
 * credit carrying decoration ("Apricot (Froot)") still matches "Apricot".
 */
function creditsArtist(rec: MbRecording, names: string[]): boolean {
	const wanted = names
		.flatMap((name) => name.split(/\s*[、，,]\s*|\s*&\s+/u))
		.map(foldName)
		.filter((name) => name !== "");
	if (wanted.length === 0) return false;
	return (rec["artist-credit"] ?? []).some((credit) => {
		const credited = foldName(credit.name ?? credit.artist?.name ?? "");
		if (credited === "") return false;
		return wanted.some(
			(name) =>
				credited === name ||
				(name.length >= 3 && credited.includes(name)) ||
				(credited.length >= 3 && name.includes(credited)),
		);
	});
}

function recordingScore(
	rec: MbRecording,
	trackName: string,
	durationSec: number,
): number {
	let score = 0;
	const recTitle = (rec.title ?? "").toLowerCase().trim();
	const query = trackName.toLowerCase().trim();
	if (recTitle === query) score += 120;
	else if (recTitle.includes(query) || query.includes(recTitle)) score += 50;
	if (VERSION_QUALIFIER.test(recTitle) && !VERSION_QUALIFIER.test(query)) {
		score -= 100;
	}
	if (rec.length !== undefined && durationSec > 0) {
		const diff = Math.abs(rec.length - durationSec * 1000);
		if (diff <= 3000) score += 40;
		else score -= Math.min(120, diff / 1000);
	}
	return score;
}

/**
 * Finds the MusicBrainz recording for a track. `trackName` is the parsed
 * main title and `artistName` the primary credit; the artist is resolved to
 * MusicBrainz' canonical name first, and the recording is then searched with
 * that name (falling back to the given one). Results are cached in
 * localStorage (keyed by artist+track) so each track is looked up once.
 * Candidate selection requires the recording to credit the track's artist —
 * the title search also returns other artists' recordings, and an artist
 * that isn't on MusicBrainz must yield no match — then scores title
 * equality, qualifier penalties (instrumental/karaoke/…), featured-artist
 * matches and duration proximity.
 */
export async function findRecording(
	trackName: string,
	artistName: string,
	durationSec: number,
	featuringArtists: string[] = [],
): Promise<RecordingMbids | null> {
	const key =
		`${artistName}::${trackName}::${[...featuringArtists].sort().join(",")}`.toLowerCase();
	const memory = memoryCache.get(key);
	if (memory !== undefined) return memory;
	if (failedLookups.has(key)) return null;
	const stored = readCache<RecordingMbids>(MBID_CACHE_KEY)[key];
	if (stored) {
		memoryCache.set(key, stored);
		return stored;
	}

	const featsLower = featuringArtists.map((f) => f.toLowerCase());

	try {
		// The recording's artist credit only matches MusicBrainz' canonical
		// name, so the queue credit is resolved first; the raw name stays as
		// a fallback when the resolved one finds nothing. A failed lookup
		// (MusicBrainz busy) is not a "no match": the miss must not be
		// remembered, so the scrobble's own lookup retries.
		let artistLookupFailed = false;
		const resolved = await findArtistName(artistName).catch((error) => {
			artistLookupFailed = true;
			console.warn("[listenbrainz] artist lookup failed:", error);
			return null;
		});
		const artistNames =
			resolved && foldName(resolved) !== foldName(artistName)
				? [resolved, artistName]
				: [artistName];
		/** Remembers a genuine "no match"; a half-finished lookup stays retryable. */
		const rememberMiss = () => {
			if (artistLookupFailed) return;
			failedLookups.add(key);
			memoryCache.set(key, null);
		};
		// Fielded queries are precise, but a title the catalog doesn't carry
		// verbatim ("❥ バッドエンドメーカー") finds nothing; the unfielded
		// "title artist" form is what the MusicBrainz search page itself
		// uses, and extra tokens don't stop it from matching.
		const queries = [
			...artistNames.map(
				(name) => `recording:"${trackName}" AND artist:"${name}"`,
			),
			`${trackName} ${artistNames[0]}`,
		];
		let recordings: MbRecording[] = [];
		for (const query of queries) {
			const data = await mbRequest<{ recordings?: MbRecording[] }>(
				`${MB_API}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
			);
			recordings = data.recordings ?? [];
			if (recordings.length > 0) break;
		}
		if (recordings.length === 0) {
			rememberMiss();
			return null;
		}
		// A recording is only a match when it credits the track's artist: the
		// title search also returns other artists' recordings of the same
		// title (the original, another cover), and when the artist isn't on
		// MusicBrainz at all, linking one of those attaches the wrong MBID.
		const candidates = recordings.filter((rec) =>
			creditsArtist(rec, artistNames),
		);
		if (candidates.length === 0) {
			rememberMiss();
			return null;
		}
		let pick = candidates[0];
		let bestScore = -Number.MAX_SAFE_INTEGER;
		for (const rec of candidates) {
			let score = recordingScore(rec, trackName, durationSec);
			if (featsLower.length > 0) {
				const creditNames = (rec["artist-credit"] ?? [])
					.map((credit) => credit.name ?? credit.artist?.name ?? "")
					.join(" ")
					.toLowerCase();
				for (const feat of featsLower) {
					if (creditNames.includes(feat)) score += 60;
				}
			}
			if (score > bestScore) {
				bestScore = score;
				pick = rec;
			}
		}
		const mbids: RecordingMbids = {
			recording: pick.id,
			artists: (pick["artist-credit"] ?? [])
				.map((credit) => credit.artist?.id)
				.filter((id): id is string => Boolean(id)),
			release: pick.releases?.[0]?.id,
		};
		memoryCache.set(key, mbids);
		const cache = readCache<RecordingMbids>(MBID_CACHE_KEY);
		cache[key] = mbids;
		writeCache(MBID_CACHE_KEY, cache);
		return mbids;
	} catch (error) {
		// MusicBrainz busy/failed: resolve to null for this call, but don't
		// remember a miss — the scrobble's own lookup, or the next play,
		// retries instead of staying unlinked for the whole session.
		console.warn("[listenbrainz] MusicBrainz lookup failed:", error);
		return null;
	}
}

/** Submits a single (finished) or "playing now" listen. */
export async function submitListen(payload: ListenPayload): Promise<void> {
	const listen: Record<string, unknown> = {
		track_metadata: {
			artist_name: payload.artistName,
			track_name: payload.trackName,
			...(payload.album ? { release_name: payload.album } : {}),
			additional_info: {
				...(payload.mbids ? { recording_mbid: payload.mbids.recording } : {}),
				...(payload.mbids?.artists?.length
					? { artist_mbids: payload.mbids.artists }
					: {}),
				...(payload.mbids?.release
					? { release_mbid: payload.mbids.release }
					: {}),
				submission_client: "YuMusic",
				submission_client_version: "0.1.0",
				music_service: "youtube.com",
			},
		},
		...(payload.listenedAt ? { listened_at: payload.listenedAt } : {}),
	};
	const res = await fetch(`${LB_API}/submit-listens`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Token ${payload.token}`,
		},
		body: JSON.stringify({
			listen_type: payload.listenedAt ? "single" : "playing_now",
			payload: [listen],
		}),
	});
	if (!res.ok) throw new Error(`ListenBrainz submit failed: ${res.status}`);
}

export async function validateListenbrainzToken(
	token: string,
): Promise<{ valid: boolean; user?: string }> {
	const res = await fetch(`${LB_API}/validate-token`, {
		headers: { Authorization: `Token ${token}` },
	});
	if (!res.ok) return { valid: false };
	const data = (await res.json()) as { valid?: boolean; user_name?: string };
	return { valid: Boolean(data.valid), user: data.user_name };
}
