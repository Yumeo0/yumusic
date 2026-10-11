import type { Song } from "@/contexts/player-context";
import {
	formatArtistName,
	formatTitleParts,
	splitDualTitle,
	splitLeadingPerformers,
} from "./title";

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
	/** The performers, from every "Singer:"/"Vocals:"/"歌:" line. */
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
 * "主題歌「Hookah, whoo!」" / "主題歌：Hookah, whoo!" / "テーマソング：X" —
 * an explicit theme-song line. It outranks generic keys like "タイトル:",
 * which product sheets use for the game/anime title instead of the song.
 */
const THEME_SONG_QUOTED =
	/^\s*[\p{P}\p{S}]*\s*(?:主題歌|テーマソング|テーマ曲)\s*[：:]?\s*[「『]([^」』]+)[」』]/u;
const THEME_SONG_PLAIN =
	/^\s*[\p{P}\p{S}]*\s*(?:主題歌|テーマソング|テーマ曲)\s*[：:]\s*(.+?)\s*$/u;

/** A "Key: Value" credit line (ASCII or full-width colon). */
const CREDIT_LINE =
	/^\s*[\p{P}\p{S}]*\s*([\p{L}\p{N}][\p{L}\p{N} .&()]{0,23})\s*[:：]\s*(.+)$/u;

/** Key of a credit line, normalized for the known-key sets. */
function creditLineKey(key: string): string {
	return key.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * "<work> by <artist>" prose credit line, e.g. "Eine Kleine Nachtmusik by
 * Wolfgang Amadeus Mozart". Split at the last "by" so works containing the
 * word ("Stand by Me by …") still resolve.
 */
const PROSE_CREDIT = /^(.{2,80})\s+by\s+(.{2,80})$/iu;

/** Leading production-role words that make a "by" line part of a credit roll. */
const PRODUCTION_WORK =
	/^(?:mixed|mastered|arranged|composed|written|produced|directed|illustrated|performed|recorded|vocals?|singer|lyrics?|music|inst(?:rumental)?|movie|video|edited?|artwork|photo|design|cover(?:ed)?)\b/i;

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
 * "Key: Value" lines (ASCII or full-width colon), keeps the first known title
 * field and every known performer field; production credits ("Director:",
 * "MV:", …) are ignored. An explicit theme-song line ("主題歌「X」") outranks
 * the generic title keys, whose product-sheet use ("タイトル:" of the game)
 * would otherwise name the wrong title. With the uploader title at hand, a
 * "<work> by <artist>" prose line that matches it is used as a fallback
 * ("Work - Composer" titles). Returns null when no recognized credit is
 * present.
 */
export function parseDescriptionCredits(
	description: string | null | undefined,
	uploaderTitle?: string,
): DescriptionCredits | null {
	if (!description) return null;
	const credits: DescriptionCredits = {};
	const artists: string[] = [];
	const seenArtists = new Set<string>();
	const lines = description.split(/\r?\n/);
	for (const line of lines) {
		const theme = line.match(THEME_SONG_QUOTED) ?? line.match(THEME_SONG_PLAIN);
		if (!theme) continue;
		const value = cleanValue(theme[1]);
		if (!value) continue;
		credits.title = stripOriginalNote(value);
		break;
	}
	for (const line of lines) {
		const match = line.match(CREDIT_LINE);
		if (!match) continue;
		const key = creditLineKey(match[1]);
		const value = cleanValue(match[2]);
		if (!value) continue;
		if (credits.title === undefined && TITLE_KEYS.has(key)) {
			credits.title = stripOriginalNote(value);
		} else if (ARTIST_KEYS.has(key)) {
			// Every performer line is kept: collabs credit each vocalist on
			// its own line ("Vocal：獅白ぼたん" / "Vocal：角巻わため").
			for (const name of splitArtistNames(value)) {
				const seen = formatArtistName(name).toLowerCase();
				if (seenArtists.has(seen)) continue;
				seenArtists.add(seen);
				artists.push(name);
			}
		}
	}
	if (artists.length > 0) credits.artist = artists.join(", ");
	// "Eine Kleine Nachtmusik by Wolfgang Amadeus Mozart" — a prose credit
	// line whose work appears in the uploader title resolves "Work -
	// Composer" titles when nothing structured is present. Production
	// chatter ("Mixed by…") and unrelated works are ignored.
	if (
		credits.title === undefined &&
		credits.artist === undefined &&
		uploaderTitle
	) {
		const folded = uploaderTitle.toLowerCase();
		for (const line of lines) {
			const prose = line.match(PROSE_CREDIT);
			if (!prose) continue;
			const work = cleanValue(prose[1]);
			const artist = cleanValue(prose[2]);
			if (!work || !artist) continue;
			if (PRODUCTION_WORK.test(work)) continue;
			if (CREDIT_TAIL.test(artist)) continue;
			if (!folded.includes(work.toLowerCase())) continue;
			credits.title = work;
			credits.artist = artist;
			break;
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

/**
 * Bracketed role credits — "(Vocal.湊あくあ)", "(歌：ななかぐら)", "(feat. X)".
 * A name inside one is a feature/vocalist credit, not the track's artist.
 */
const ROLE_BRACKET =
	/[(（【『「]\s*(?:vocal|vo|feat(?:uring)?|ft|歌|cv)\s*[.:：・][^)）】』」]*[)）】』」]/giu;

/**
 * A bare feature tail — "… feat. 初音ミク", "… ft. X" — which credits a
 * feature performance, not the track's artist.
 */
const FEAT_TAIL = /(?<!\p{L})(?:feat(?:uring)?|ft)(?:\.\s*|\s+).*$/iu;

/** Whether the title credits the parsed artist ("Nameless - Song"). */
function artistMentionedInTitle(title: string, artist: string): boolean {
	// Role-bracketed ("(Vocal.X)") and feature-tail ("feat. X") mentions
	// credit a feature performance, not the track's artist, so they don't
	// count as a title credit.
	const plain = title.replace(ROLE_BRACKET, " ").replace(FEAT_TAIL, " ");
	const foldedTitle = plain.toLowerCase();
	const titleWords = new Set(
		foldedTitle.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
	);
	return splitArtistNames(artist).some((name) => {
		const needle = name.toLowerCase();
		if (needle.length >= 2 && foldedTitle.includes(needle)) return true;
		// "Eine Kleine Nachtmusik - Mozart" credits the description's full
		// "Wolfgang Amadeus Mozart" through a single name part.
		return name
			.toLowerCase()
			.split(/\s+/)
			.some((part) => part.length >= 4 && titleWords.has(part));
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

/** A line carrying links/handles next to, at most, bracketed labels. */
function isLinkLine(line: string): boolean {
	return extractLinkTokens(line).length > 0 && stripLinks(line).trim() === "";
}

/** The line with its URLs, @handles and bracketed labels removed. */
function stripLinks(line: string): string {
	return line
		.replace(/https?:\/\/\S+/giu, " ")
		.replace(/(?<![\p{L}\p{N}])@[\w.-]+/gu, " ")
		.replace(
			/[[(（【［『「][^[\]()（）【】［］『』「」]{0,30}[\]）)】］』」]/gu,
			" ",
		);
}

/**
 * The @handles, profile slugs and channel ids a line carries
 * (twitter/x/instagram/YouTube).
 */
function extractLinkTokens(line: string): string[] {
	const tokens = new Set<string>();
	for (const match of line.matchAll(/(?<![\p{L}\p{N}])@([\w.-]{2,30})/gu)) {
		tokens.add(match[1]);
	}
	for (const match of line.matchAll(
		/(?<![\w.@])(?:twitter|x|instagram)\.com\/([\w.-]{2,30})/giu,
	)) {
		tokens.add(match[1]);
	}
	for (const match of line.matchAll(/youtube\.com\/@([\w.-]{2,30})/giu)) {
		tokens.add(match[1]);
	}
	for (const match of line.matchAll(
		/youtube\.com\/channel\/(UC[\w-]{22})/giu,
	)) {
		tokens.add(match[1]);
	}
	return [...tokens];
}

/** Folds a name or handle for comparison, reading "+" as "plus". */
function linkKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/\+/g, "plus")
		.replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Whether a stored artist name corresponds to a handle or profile slug. */
function linkMatchesName(name: string, token: string): boolean {
	const link = linkKey(token);
	if (!link) return false;
	if (linkKey(name) === link) return true;
	// "Shion Murasaki" ↔ "MurasakiShion": every word of the name appears.
	const words = name
		.toLowerCase()
		.split(/[\s._-]+/)
		.map(linkKey)
		.filter((word) => word.length >= 2);
	return words.length >= 2 && words.every((word) => link.includes(word));
}

/**
 * Channel ids for the description's performer names, resolved through the
 * @handles, profile links and channel URLs uploaders put next to a credit
 * line: the stored "La+ Darknesss" matches "@LaplusDarknesss" under "Vocal:
 * 紫咲シオン × ラプラス・ダークネス", so its id moves to ラプラス・ダークネス,
 * "Minato Aqua" matches the "twitter.com/minatoaqua" link on the
 * "Vocal：湊あくあ" line, and a "[YouTube] …/channel/UC…" link under
 * "Vocal：町田ちま" links the name directly. Stored-artist matches win over
 * channel URLs.
 */
function linkedArtistIds(song: Song, description: string): Map<string, string> {
	const ids = new Map<string, string>();
	const stored = (
		song.artists?.length
			? song.artists
			: song.artist
				? [{ name: song.artist, id: song.artistId }]
				: []
	).filter((artist) => artist.name && artist.id);
	const lines = description.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].match(CREDIT_LINE);
		if (!match || !ARTIST_KEYS.has(creditLineKey(match[1]))) continue;
		const value = cleanValue(match[2]);
		if (!value) continue;
		const names = splitArtistNames(value);
		const links = extractLinkTokens(lines[i]);
		// The credit's own links usually sit on the labelled lines below it
		// ("[YouTube] https://…", "[Twitter] https://…").
		for (let j = i + 1; j < lines.length && isLinkLine(lines[j]); j++) {
			for (const token of extractLinkTokens(lines[j])) {
				if (!links.includes(token)) links.push(token);
			}
		}
		if (links.length === 0) continue;
		// Pair names with links: one link per name, or one name carrying all
		// of its links. Anything else is too ambiguous to attribute.
		const pairs: Array<[string, string]> =
			names.length === links.length
				? names.map((name, index): [string, string] => [name, links[index]])
				: names.length === 1
					? links.map((link): [string, string] => [names[0], link])
					: [];
		for (const [name, link] of pairs) {
			// A channel URL is the id itself; the stored artist's id (when its
			// name matches a handle) takes precedence.
			if (/^UC[\w-]{22}$/.test(link)) {
				if (!ids.has(name)) ids.set(name, link);
				continue;
			}
			const artist = stored.find((entry) => linkMatchesName(entry.name, link));
			if (artist?.id) ids.set(name, artist.id);
		}
	}
	return ids;
}

/**
 * Applies a video description to a song: stores the raw text and uses the
 * structured credits to correct the title and artist. The parsed performer is
 * adopted when the uploader title already credits them (the cover form
 * "Singer - Song"), when no real artist is known, or when the credit lists
 * several performers ("Vocal: A × B"); a lone "Vocals:" name in a production
 * credit roll leaves the artist untouched. Stored channel ids follow their
 * artist through the description's @handles and profile links ("La+
 * Darknesss" ↔ "@LaplusDarknesss"). Performers parsed from the original
 * title's credits ("A×B「Song」" lists, cover casts) carry over when the
 * description replaces the title. Returns the same object when the
 * description was already applied or adds nothing.
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
	const credits = parseDescriptionCredits(full, song.title);
	if (!credits) return next;
	if (credits.title) next.title = credits.title;
	// The description's credited names keep their channel links on the song,
	// so a featured performer renders as a link even without the artist role.
	const linked = linkedArtistIds(song, full);
	if (linked.size > 0) {
		const creditIds = [...(next.creditIds ?? [])];
		for (const [name, id] of linked) {
			if (!creditIds.some((credit) => sameArtistName(credit.name, name))) {
				creditIds.push({ name, id });
			}
		}
		next.creditIds = creditIds;
	}
	if (credits.artist) {
		const names = splitArtistNames(credits.artist);
		// Several performers ("Vocal: A × B") are the track's artists even
		// when the title doesn't name them; a single name is adopted only
		// when the title credits it or no real artist is known, so production
		// credit rolls ("Vocals: vally.exe") keep the channel.
		const adopt =
			names.length >= 2 ||
			artistMentionedInTitle(song.title, credits.artist) ||
			isPlaceholderArtist(song.artist);
		if (names.length > 0 && adopt) {
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
				const resolved = match?.name ?? name;
				// An exact match without an id still benefits from the
				// description's channel links.
				const id = match?.id ?? linked.get(name);
				return id ? { name: resolved, id } : { name: resolved };
			});
			next.artists = artists;
			next.artist = artists.map((artist) => artist.name).join(", ");
			next.artistId = artists.find((artist) => artist.id)?.id;
		}
	}
	// The display pipeline parses those extra performers from the title text
	// at render time; once the title is replaced they would disappear.
	if (credits.title && credits.title !== song.title) {
		const fromTitle = formatTitleParts(
			song.title,
			"original",
			true,
			song.artist,
		).coverArtists;
		if (fromTitle.length > 0) {
			const artists = next.artists?.length
				? [...next.artists]
				: song.artist
					? [{ name: song.artist, id: song.artistId }]
					: [];
			for (const name of fromTitle) {
				if (!artists.some((artist) => sameArtistName(artist.name, name))) {
					artists.push({ name });
				}
			}
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

/** Comparison keys of the artists already attached to a song. */
function knownArtistKeys(song: Song): string[] {
	return [song.artist, ...(song.artists ?? []).map((artist) => artist.name)]
		.map(creditKey)
		.filter((key) => key.length >= 2);
}

/**
 * Whether fetching this song's description could plausibly change its parsed
 * title/artist. The prefetch only spends a request on these; whatever is
 * playing already gets its description from the player response.
 *
 * The signal is a leading "Name - Song" / "Name / Song" credit whose name is
 * not one of the song's known artists — e.g. "Nameless - Milk Crown on
 * Sonnetica (Lyrics Romaji)" uploaded by "Doga" — or a leading "A×B「Song」"
 * performer list the channel doesn't represent. The regex pipeline cannot
 * tell whether "Nameless" is the singer or part of the title, but the
 * description's "Singer:"/"Song:" lines can.
 */
export function titleNeedsDescription(song: Song): boolean {
	// "藍月なくる×DECO*27×tepe「Hookah, whoo!」MV" uploaded by a label: the
	// description's "歌:"/"Singer:" line names the actual performers.
	const leading = splitLeadingPerformers(song.title);
	if (leading) {
		const knownKeys = knownArtistKeys(song);
		return !leading.performers.some((name) =>
			knownKeys.includes(creditKey(name)),
		);
	}
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
	const knownKeys = knownArtistKeys(song);
	const leftKey = creditKey(left);
	if (knownKeys.includes(leftKey)) return false;
	const rightKey = creditKey(right);
	return !knownKeys.some(
		(key) =>
			rightKey === key || rightKey.includes(key) || key.includes(rightKey),
	);
}
