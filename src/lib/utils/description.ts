import type { Song } from "@/contexts/player-context";
import { formatArtistName, splitDualTitle } from "./title";

/**
 * Structured credits some uploaders put in the video description —
 * "Singer: Nameless" / "Song: Milk Crown On Sonnetica (Original - Hatsune
 * miku)". The uploader title alone often credits the channel (or a cover
 * branding) instead of the actual song, so these lines are used to resolve a
 * song's real title and performer.
 */
export interface DescriptionCredits {
	/** The song's actual title, from a "Song:"/"Title:"/"曲名:" line. */
	title?: string;
	/** The performing artist, from a "Singer:"/"Vocals:"/"歌:" line. */
	artist?: string;
}

/** Description keys that name the song's title. */
const TITLE_KEYS = new Set([
	"song",
	"song title",
	"song name",
	"title",
	"track",
	"track title",
	"track name",
	"曲名",
	"楽曲",
	"楽曲名",
	"タイトル",
	"歌名",
]);

/** Description keys that name the song's performer. */
const ARTIST_KEYS = new Set([
	"singer",
	"singers",
	"singer(s)",
	"vocal",
	"vocals",
	"vocalist",
	"artist",
	"artists",
	"artist name",
	"cv",
	"c.v.",
	"cover by",
	"covered by",
	"song by",
	"歌",
	"歌い手",
	"歌手",
	"歌唱",
	"ボーカル",
	"唄",
]);

/**
 * Longest accepted credit value. Longer values are prose ("Director: join us
 * on…") rather than a name or song title.
 */
const MAX_VALUE_LENGTH = 120;

/**
 * Descriptions are stored truncated so long lyric dumps don't bloat the
 * playlist caches; credits sit near the top of a description sheet. Parsing
 * runs on the full text, so a later field is still recognized this time.
 */
const MAX_STORED_DESCRIPTION_LENGTH = 4000;

/**
 * "Milk Crown On Sonnetica (Original - Hatsune miku)" → "Milk Crown On
 * Sonnetica": a trailing parenthetical naming the original work is not part
 * of the song's title.
 */
function stripOriginalNote(value: string): string {
	const stripped = value
		.replace(/\s*[(（]\s*(?:original\b|原曲)[^)）]*[)）]\s*$/iu, "")
		.trim();
	return stripped || value;
}

/** Cleans a credit value: drops links/handles and surrounding punctuation. */
function cleanValue(raw: string): string | null {
	const value = raw
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/(?<![\p{L}\p{N}])@[\w.]+/gu, " ")
		.replace(/\s+/g, " ")
		.replace(/^[\s\-–—:：·・]+|[\s\-–—:：·・,，、&]+$/g, "")
		.trim();
	return value.length > 0 && value.length <= MAX_VALUE_LENGTH ? value : null;
}

/**
 * Pulls the structured song credits out of a video description. Reads
 * "Key: Value" lines (ASCII or full-width colon) and keeps the first known
 * title/performer field; production credits ("Director:", "MV:", …) are
 * ignored. Returns null when no recognized credit is present.
 */
export function parseDescriptionCredits(
	description: string | null | undefined,
): DescriptionCredits | null {
	if (!description) return null;
	const credits: DescriptionCredits = {};
	for (const line of description.split(/\r?\n/)) {
		const match = line.match(
			/^\s*[\p{P}\p{S}]*\s*([\p{L}\p{N}][\p{L}\p{N} .&()]{0,23})\s*[:：]\s*(.+)$/u,
		);
		if (!match) continue;
		const key = match[1].trim().toLowerCase().replace(/\s+/g, " ");
		const value = cleanValue(match[2]);
		if (!value) continue;
		if (credits.title === undefined && TITLE_KEYS.has(key)) {
			credits.title = stripOriginalNote(value);
		} else if (credits.artist === undefined && ARTIST_KEYS.has(key)) {
			credits.artist = value;
		}
	}
	return credits.title !== undefined || credits.artist !== undefined
		? credits
		: null;
}

/** Splits a credit list ("A, B & C") into individual names. */
function splitArtistNames(raw: string): string[] {
	return raw
		.split(/\s*[，,、]\s*|\s*&\s*|\s*[×✕]\s*|\s*\/\s*/u)
		.map((name) => name.trim())
		.filter((name) => name.length > 0 && name.length <= 60)
		.slice(0, 8);
}

/** Whether the title credits the parsed artist ("Nameless - Song"). */
function artistMentionedInTitle(title: string, artist: string): boolean {
	const folded = title.toLowerCase();
	return splitArtistNames(artist).some((name) => {
		const needle = name.toLowerCase();
		return needle.length >= 2 && folded.includes(needle);
	});
}

/** Whether the song's own artist credit is a placeholder. */
function isPlaceholderArtist(artist: string): boolean {
	const trimmed = artist.trim();
	return trimmed === "" || /^unknown artist$/i.test(trimmed);
}

/** Whether an existing artist entry is the same credit as a parsed name. */
function sameArtistName(a: string, b: string): boolean {
	return (
		formatArtistName(a).toLowerCase() === formatArtistName(b).toLowerCase()
	);
}

/**
 * Applies a video description to a song: stores the raw text and uses the
 * structured credits to correct the title and artist. The parsed performer is
 * adopted when the uploader title already credits them (the cover form
 * "Singer - Song") or when no real artist is known; production credit rolls
 * ("Vocals:" among many roles) leave the artist untouched. Returns the same
 * object when the description was already applied or adds nothing.
 */
export function applySongDescription(
	song: Song,
	description: string | null | undefined,
): Song {
	const full = description?.trim();
	if (!full) return song;
	const text =
		full.length > MAX_STORED_DESCRIPTION_LENGTH
			? full.slice(0, MAX_STORED_DESCRIPTION_LENGTH)
			: full;
	if (song.description === text) return song;
	const next: Song = { ...song, description: text };
	const credits = parseDescriptionCredits(full);
	if (!credits) return next;
	if (credits.title) next.title = credits.title;
	if (
		credits.artist &&
		(artistMentionedInTitle(song.title, credits.artist) ||
			isPlaceholderArtist(song.artist))
	) {
		const names = splitArtistNames(credits.artist);
		if (names.length > 0) {
			const existing: Array<{ name: string; id?: string }> = song.artists
				?.length
				? song.artists
				: song.artist
					? [{ name: song.artist, id: song.artistId }]
					: [];
			const artists = names.map((name): { name: string; id?: string } => {
				const match = existing.find((artist) =>
					sameArtistName(artist.name, name),
				);
				return match ? { name: match.name, id: match.id } : { name };
			});
			next.artists = artists;
			next.artist = artists.map((artist) => artist.name).join(", ");
			next.artistId = artists.find((artist) => artist.id)?.id;
		}
	}
	return next;
}

/**
 * Leading credit separator: "Name - Song", "Name – Song", "Name / Song" and
 * the glued Japanese form "snooze／眠雲ツクリ". A bare ASCII slash inside a
 * name ("AC/DC") is not a separator.
 */
const LEADING_CREDIT = /^(.{1,60}?)(?:\s+[-–—]\s+|\s*／\s*|\s+\/\s+)(.+)$/u;

/** Right sides that are version/credit tails, not an unknown artist name. */
const CREDIT_TAIL =
	/^(?:feat|ft|featuring|cover(?:ed)?|remix|rmx|ver|version|inst|instrumental|mv|m\/v|pv|official|lyrics?|english|japanese|korean|chinese|romaji|live|acoustic|karaoke|demo|extended|remaster(?:ed)?|nightcore|sped|slowed|reverb|lofi|tv)\b/i;

/** Comparison key for an artist name: normalized, lowercase, punctuation-free. */
function creditKey(name: string): string {
	return formatArtistName(name)
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Whether fetching this song's description could plausibly change its parsed
 * title/artist. The prefetch only spends a request on these; whatever is
 * playing already gets its description from the player response.
 *
 * The signal is a leading "Name - Song" / "Name / Song" credit whose name is
 * not one of the song's known artists — e.g. "Nameless - Milk Crown on
 * Sonnetica (Lyrics Romaji)" uploaded by "Doga". The regex pipeline cannot
 * tell whether "Nameless" is the singer or part of the title, but the
 * description's "Singer:"/"Song:" lines can.
 */
export function titleNeedsDescription(song: Song): boolean {
	const match = song.title.match(LEADING_CREDIT);
	if (!match) return false;
	const left = match[1].trim();
	const right = match[2].trim();
	if (!left || !right) return false;
	// "Song - Remix" / "Song - ft. X": a version/feat tail, not a credit.
	if (CREDIT_TAIL.test(right)) return false;
	// "夜駆け - Night Run": the dual-title parser already resolves this pair.
	if (splitDualTitle(song.title)) return false;
	// A real credit is a short, plain name (no brackets, no decorations).
	if (left.length < 2 || left.length > 50) return false;
	if (/[([（【『「]/.test(left)) return false;
	// A side matching a known artist is already handled by the title
	// pipeline: the prefix strip takes exact matches ("Artist - Song"), the
	// suffix strip also accepts channel-decorated names ("song - Artist Ch.").
	const knownKeys = [song.artist, ...(song.artists ?? []).map((a) => a.name)]
		.map(creditKey)
		.filter((key) => key.length >= 2);
	const leftKey = creditKey(left);
	if (knownKeys.includes(leftKey)) return false;
	const rightKey = creditKey(right);
	return !knownKeys.some(
		(key) =>
			rightKey === key || rightKey.includes(key) || key.includes(rightKey),
	);
}
