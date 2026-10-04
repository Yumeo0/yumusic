/**
 * ListenBrainz scrobbling with MusicBrainz track lookup: recordings are
 * searched on MusicBrainz first so the submitted listen carries the
 * recording MBID and ListenBrainz doesn't have to match it itself.
 */

const LB_API = "https://api.listenbrainz.org/1";
const MB_API = "https://musicbrainz.org/ws/2";
const MBID_CACHE_KEY = "yumusic:mbids";
const MBID_CACHE_MAX = 200;

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

type MbidCache = Record<string, RecordingMbids>;

const memoryCache = new Map<string, RecordingMbids | null>();
/** Session-scoped negative cache so failed lookups aren't hammered. */
const failedLookups = new Set<string>();

function readMbidCache(): MbidCache {
	try {
		return JSON.parse(
			localStorage.getItem(MBID_CACHE_KEY) ?? "{}",
		) as MbidCache;
	} catch {
		return {};
	}
}

function writeMbidCache(cache: MbidCache) {
	try {
		const entries = Object.entries(cache).slice(-MBID_CACHE_MAX);
		localStorage.setItem(
			MBID_CACHE_KEY,
			JSON.stringify(Object.fromEntries(entries)),
		);
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

/** MusicBrainz allows ~1 request/second — serialize with 1.1s spacing. */
function mbRequest<T>(url: string): Promise<T> {
	const run = mbQueue.then(async () => {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`MusicBrainz ${res.status}`);
		return (await res.json()) as T;
	});
	mbQueue = run.then(
		() => new Promise((resolve) => setTimeout(resolve, 1100)),
		() => new Promise((resolve) => setTimeout(resolve, 1100)),
	);
	return run;
}

/** Penalize instrumental/karaoke-style qualifiers when the query lacks them. */
const VERSION_QUALIFIER =
	/\b(?:instrumental|off\s?vocal|offvocal|karaoke|acapella|a\s?cappella|backing\s?track|tv\s?size|tv\s?ver(?:sion)?|game\s?ver(?:sion)?|movie\s?ver(?:sion)?|short\s?ver(?:sion)?|remix|cover)\b/i;

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
 * Finds the MusicBrainz recording for a track. Results are cached in
 * localStorage (keyed by artist+track) so each track is looked up once.
 * Candidate selection scores title equality, qualifier penalties
 * (instrumental/karaoke/…), duration proximity and featured-artist credit
 * matches — the raw search ranking regularly prefers "… Instrumental"
 * entries.
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
	const stored = readMbidCache()[key];
	if (stored) {
		memoryCache.set(key, stored);
		return stored;
	}

	const featsLower = featuringArtists.map((f) => f.toLowerCase());

	try {
		const query = `recording:"${trackName}" AND artist:"${artistName}"`;
		const data = await mbRequest<{ recordings?: MbRecording[] }>(
			`${MB_API}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`,
		);
		const recordings = data.recordings ?? [];
		if (recordings.length === 0) {
			failedLookups.add(key);
			memoryCache.set(key, null);
			return null;
		}
		let pick = recordings[0];
		let bestScore = -Number.MAX_SAFE_INTEGER;
		for (const rec of recordings) {
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
		const cache = readMbidCache();
		cache[key] = mbids;
		writeMbidCache(cache);
		return mbids;
	} catch (error) {
		console.warn("[listenbrainz] MusicBrainz lookup failed:", error);
		failedLookups.add(key);
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
