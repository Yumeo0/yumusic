import { cleanSearchTitle } from "../utils/title";

/**
 * VocaDB lyrics provider. VocaDB catalogs Vocaloid/utaite songs — the core of
 * this app's catalog — and exposes plain-text lyrics through a free,
 * CORS-enabled API. YouTube titles carry decorations ("【…】", "歌ってみた",
 * "(Cover)") that VocaDB's exact name search does not see through, so the
 * query is stripped down to the bare song name first.
 *
 * Lyrics text isn't part of the search/details payloads: the details response
 * only carries the lyrics entry id (`preferredLyrics`, or the parent song's
 * lyrics for covers), which then resolves through the lyrics endpoint.
 */

const API = "https://vocadb.net/api";
/** Candidate songs whose details/lyrics are checked before giving up. */
const MAX_CANDIDATES = 3;

interface VocadbSong {
	id: number;
	name: string;
	defaultName?: string;
	additionalNames?: string;
	songType?: string;
	lengthSeconds?: number;
}

interface VocadbLyricsRef {
	id: number;
	translationType?: string;
}

interface VocadbDetails {
	preferredLyrics?: VocadbLyricsRef | null;
	lyricsFromParents?: VocadbLyricsRef[];
}

interface VocadbLyricsResponse {
	value?: string;
}

/** Folds a name for comparison (case/space/punctuation-insensitive). */
function foldName(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * Strips the decorations YouTube titles carry down to the bare song name that
 * VocaDB entries use: "【正統派カワボが】ザムザ【本気で】歌ってみた" → "ザムザ".
 */
function searchName(title: string, artist: string): string {
	return cleanSearchTitle(title, artist)
		.replace(/【[^】]*】|『[^』]*』|「[^」]*」|《[^》]*》|〈[^〉]*〉/gu, " ")
		.replace(/[歌弾踊叩]ってみた/gu, " ")
		.replace(
			/\b(?:cover(?:ed)?(?:\s+by\s+\S+)?|mv|m\/v|pv|official(?:\s+(?:music\s+)?video)?|music\s+video|lyrics?)\b/giu,
			" ",
		)
		.replace(/[(（[\]{}）)]/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim();
}

function namesOf(song: VocadbSong): string[] {
	return [
		song.name,
		song.defaultName,
		...(song.additionalNames?.split(",") ?? []),
	]
		.map((name) => name?.trim())
		.filter((name): name is string => !!name);
}

/**
 * Fetches plain lyrics from VocaDB for a track. Prefers the original song over
 * covers/remixes and the closest duration, then resolves the first candidate
 * that actually has lyrics. Returns null when nothing usable is found.
 */
export async function fetchVocadbLyrics(
	title: string,
	artist: string,
	durationSec: number,
): Promise<string | null> {
	const query = searchName(title, artist);
	if (!query) return null;

	try {
		const params = new URLSearchParams({
			start: "0",
			getTotalCount: "false",
			maxResults: "10",
			query,
			lang: "Default",
			nameMatchMode: "Exact",
			sort: "None",
			fields: "AdditionalNames",
		});
		const res = await fetch(`${API}/songs?${params}`);
		if (!res.ok) return null;
		const data = (await res.json()) as { items?: VocadbSong[] };
		const target = foldName(query);
		const candidates = (data.items ?? [])
			.filter((song) => namesOf(song).some((name) => foldName(name) === target))
			.filter((song) => song.songType !== "Instrumental")
			.sort((a, b) => {
				const originalA = a.songType === "Original" ? 0 : 1;
				const originalB = b.songType === "Original" ? 0 : 1;
				if (originalA !== originalB) return originalA - originalB;
				const deltaA =
					durationSec > 0 && a.lengthSeconds
						? Math.abs(a.lengthSeconds - durationSec)
						: Number.POSITIVE_INFINITY;
				const deltaB =
					durationSec > 0 && b.lengthSeconds
						? Math.abs(b.lengthSeconds - durationSec)
						: Number.POSITIVE_INFINITY;
				return deltaA - deltaB;
			});

		for (const song of candidates.slice(0, MAX_CANDIDATES)) {
			const detailsRes = await fetch(`${API}/songs/${song.id}/details`);
			if (!detailsRes.ok) continue;
			const details = (await detailsRes.json()) as VocadbDetails;
			// Covers may have no lyrics of their own and inherit the original's.
			// The preferred entry is language-dependent (it may be a
			// translation), so the original-language lyrics win when present.
			const refs = [
				details.preferredLyrics,
				...(details.lyricsFromParents ?? []),
			].filter((ref): ref is VocadbLyricsRef => !!ref);
			const lyricsRef =
				refs.find((ref) => ref.translationType === "Original") ?? refs[0];
			if (!lyricsRef) continue;
			const lyricsRes = await fetch(`${API}/songs/lyrics/${lyricsRef.id}`);
			if (!lyricsRes.ok) continue;
			const lyrics = (await lyricsRes.json()) as VocadbLyricsResponse;
			const value = lyrics.value?.trim();
			if (value) return value;
		}

		return null;
	} catch (error) {
		console.warn("[vocadb] lyrics lookup failed:", error);
		return null;
	}
}
