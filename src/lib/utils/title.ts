import { useCallback } from "react";
import { type TitleMode, useSettings } from "../stores/settings";

/**
 * Detects the "Original - Translation" dual-title form YouTube uses for
 * non-Latin tracks (e.g. "本能スピード - Instinctive Speed"): the left side
 * must contain non-Latin script, the right side must be Latin-only. Returns
 * null for single-language titles, which are shown unchanged in every mode.
 */
const NON_LATIN =
	/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Cyrillic}|\p{Script=Greek}|\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Thai}/u;
const LATIN_ONLY = /^[\p{Script=Latin}\p{M}\p{N}\p{P}\p{S}\s]+$/u;

export function splitDualTitle(
	title: string,
): { original: string; translation: string } | null {
	// Typographic hyphens (U+2010–U+2015) are folded to the ASCII " - " form
	// YouTube uses, so "音乃瀬奏 ‐ ReGLOSS" splits like "Name - Reading".
	const normalized = title.replace(/\s[\u2010-\u2015]\s/gu, " - ");
	for (const separator of [" - ", " / ", "／", "//"]) {
		const idx = normalized.lastIndexOf(separator);
		if (idx <= 0 || idx >= normalized.length - separator.length) continue;
		const left = normalized.slice(0, idx).trim();
		const right = normalized.slice(idx + separator.length).trim();
		if (!left || !right) continue;
		if (!NON_LATIN.test(left) || !LATIN_ONLY.test(right)) continue;
		return { original: left, translation: right };
	}
	return null;
}

/** Applies the dual-title display mode to a cleaned title. */
function applyMode(main: string, mode: TitleMode): string {
	if (mode === "both") return main;
	const split = splitDualTitle(main);
	if (!split) return main;
	return mode === "original" ? split.original : split.translation;
}

/**
 * Channel-name form VTubers use, e.g. "Shion Ch. 紫咲シオン": a Latin name
 * followed by "Ch."/"Channel" and the original-language name.
 */
const CHANNEL_NAME = /^(.+?)\s+Ch(?:annel)?(?:\.\s*|\s+)(.+)$/iu;

/**
 * The same channel form with the marker glued to the name —
 * "Towa Ch.Tokoyami Towa". A glued "Ch." is a decorator even when both
 * halves are Latin; the spaced "Charlie Ch. Brown" keeps its middle initial.
 */
const CHANNEL_NAME_GLUED = /^(.+?)\s+Ch(?:annel)?\.(\S.*)$/iu;

/** Trailing channel marker: "…channel", "…Ch.", "…ちゃんねる", "…チャンネル". */
const CHANNEL_MARKER = /(?:channel|ch\.|ちゃんねる|チャンネル)$/iu;

/** Slash-separated alias form, e.g. "カグラナナchannel／ななかぐら". */
const ALIAS_NAME = /^(.+?)\s*[／/]\s*(.+)$/u;

/** One normalization step for an artist name, or null when nothing changes. */
function normalizeArtistName(name: string): string | null {
	// A channel marker before the slash makes the right half an alias of the
	// channel rather than a second artist: drop marker and alias.
	const alias = name.match(ALIAS_NAME);
	if (alias && CHANNEL_MARKER.test(alias[1])) {
		const head = alias[1].replace(CHANNEL_MARKER, "").trim();
		if (head) return head;
	}
	// "Kanade Ch. 音乃瀬奏 ‐ ReGLOSS": split the group/reading half first,
	// the next round then strips the channel prefix from the original half.
	const split = splitDualTitle(name);
	if (split) return split.original;
	const channel = name.match(CHANNEL_NAME);
	if (channel) {
		const prefix = channel[1].trim();
		const suffix = channel[2].trim();
		if (LATIN_ONLY.test(prefix) && NON_LATIN.test(suffix)) return suffix;
		if (NON_LATIN.test(prefix) && LATIN_ONLY.test(suffix)) return prefix;
		// With both halves Latin, a channel decorator shows as a glued
		// marker ("Towa Ch.Tokoyami Towa" keeps the name after it) or a
		// lowercase group tag ("Nanashi Mumei Ch. hololive-EN" keeps the
		// name before it); the spaced "Charlie Ch. Brown" keeps its middle
		// initial.
		if (LATIN_ONLY.test(prefix) && LATIN_ONLY.test(suffix)) {
			if (CHANNEL_NAME_GLUED.test(name)) return suffix;
			if (/^\p{Ll}/u.test(suffix)) return prefix;
		}
	}
	// Bare trailing marker: "カグラナナchannel" → "カグラナナ".
	const trailing = name.match(CHANNEL_MARKER);
	if (trailing?.index) {
		const head = name.slice(0, trailing.index).trim();
		if (head) return head;
	}
	// Bracketed group tags: "Elira Pendora 【NIJISANJI EN】" → "Elira Pendora".
	// Credit brackets stay: "Ellen Joe (CV:Shion Wakayama)".
	const core = dropGroupTags(name);
	if (core && core !== name) return core;
	return null;
}

/**
 * Keeps only the original-language half of a dual artist name such as
 * "眠雲ツクリ / NemukumoTsukuri" — YouTube Music appends the romaji reading
 * after a slash. Also handles the reversed channel-name form
 * ("Shion Ch. 紫咲シオン" → "紫咲シオン") and channel aliases
 * ("カグラナナchannel／ななかぐら" → "カグラナナ"). Names whose original
 * half is already Latin, or that have no Latin counterpart, are returned
 * unchanged.
 */
export function formatArtistName(name: string): string {
	let out = name.trim();
	for (let step = 0; step < 4; step++) {
		const next = normalizeArtistName(out);
		if (!next || next === out) break;
		out = next;
	}
	return out;
}

/** Case-insensitive comparison key for artist credits. */
function artistKey(name: string): string {
	return name.trim().toLowerCase();
}

/** Whether a name is written entirely in Latin script ("Minato Aqua"). */
function isLatinName(name: string): boolean {
	return LATIN_ONLY.test(name) && !NON_LATIN.test(name);
}

/**
 * The same credit when one name is the other plus a "Ch."/"Channel" group
 * suffix ("Kobo Kanaeru Ch. hololive" vs the title's "Kobo Kanaeru").
 * Returns the clean name, or null when the names are unrelated.
 */
function channelDecoratedPair(a: string, b: string): string | null {
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	if (shorter.length === 0) return null;
	if (longer.slice(0, shorter.length).toLowerCase() !== shorter.toLowerCase()) {
		return null;
	}
	const rest = longer.slice(shorter.length);
	return /^\s+ch(?:annel)?\.?\s+\S/i.test(rest) ? shorter : null;
}

/**
 * Merges a song's artists with the cover performers parsed from the title.
 * Names are normalized first ("Shion Ch. 紫咲シオン" → "紫咲シオン"). Entries
 * at the same position are the same credit when they match case-insensitively
 * or only differ in script ("Minato Aqua" / "湊あくあ") — the original-script
 * name then wins and keeps the channel link when there is one. Remaining
 * covers (e.g. an extra collaborator at another position) are appended unless
 * an artist already carries that name.
 */
export function mergeArtistNames(
	artists: Array<{ name: string; id?: string }>,
	covers: string[],
): Array<{ name: string; id?: string }> {
	const names = covers.map(formatArtistName);
	const consumed = names.map(() => false);
	const merged: Array<{ name: string; id?: string }> = [];
	for (let i = 0; i < artists.length; i++) {
		const artist = artists[i];
		const artistName = formatArtistName(artist.name);
		const coverName = names[i];
		if (coverName && artistKey(artistName) === artistKey(coverName)) {
			consumed[i] = true;
			merged.push({ name: artistName, id: artist.id });
			continue;
		}
		const channelPair = coverName
			? channelDecoratedPair(artistName, coverName)
			: null;
		if (channelPair) {
			consumed[i] = true;
			merged.push({ name: channelPair, id: artist.id });
			continue;
		}
		if (coverName && isLatinName(artistName) !== isLatinName(coverName)) {
			consumed[i] = true;
			merged.push(
				isLatinName(coverName)
					? { name: artistName, id: artist.id }
					: { name: coverName, id: artist.id },
			);
			continue;
		}
		merged.push({ name: artistName, id: artist.id });
	}
	const known = new Set(merged.map((a) => artistKey(a.name)));
	for (let i = 0; i < names.length; i++) {
		if (consumed[i] || known.has(artistKey(names[i]))) continue;
		known.add(artistKey(names[i]));
		merged.push({ name: names[i] });
	}
	return merged;
}

const FEAT_BRACKETED =
	/\s*[（[(]\s*(?:feat(?:uring)?|ft)\.?\s*([^）\])]+)[）\])]\s*$/iu;
const FEAT_TAIL = /(?<!\p{L})(?:feat(?:uring)?|ft)\.?\s*(.+)$/iu;

/**
 * "(Vocal.湊あくあ)" / "(歌：ななかぐら)" — a parenthesized vocal credit, the
 * featured performer of remix/cover titles like
 * "Take Over (Vocal.湊あくあ)[Dyako Remix]".
 */
const VOCAL_CREDIT =
	/\s*[（[(]\s*(?:vocal|vo|歌)\s*[.:：・]\s*([^）\])]{1,60}?)\s*[）\])]\s*$/iu;

/**
 * Splits a "feat. A, B & C" / "ft. A" / "(feat. A, B & C)" / "(Vocal.A)"
 * tail off the title. In the "Artist feat. A - Song" shape the dash separates
 * the artists from the song, so only the feat names come off and the song
 * rejoins the main title ("Artist - Song").
 */
export function splitFeaturedTitle(title: string): {
	main: string;
	feats: string[];
} {
	for (const pattern of [FEAT_BRACKETED, VOCAL_CREDIT]) {
		const match = title.match(pattern);
		if (!match) continue;
		const feats = splitArtistList(match[1]);
		if (feats.length > 0) {
			return { main: title.slice(0, match.index).trim(), feats };
		}
	}
	const match = title.match(FEAT_TAIL);
	if (match) {
		const { names, song } = splitFeatTail(match[1]);
		const feats = splitArtistList(names);
		if (feats.length > 0) {
			const prefix = title.slice(0, match.index).trim();
			const main = song ? [prefix, song].filter(Boolean).join(" - ") : prefix;
			return { main, feats };
		}
	}
	return { main: title, feats: [] };
}

/**
 * The feat names and song title of a raw "A & B - Song" feat tail. A spaced
 * dash is the separator; a glued one stays part of a name ("Jay-Z"), and
 * bracketed tails are owned by the patterns above.
 */
function splitFeatTail(tail: string): { names: string; song?: string } {
	if (/[()（）[\]【】]/u.test(tail)) return { names: tail };
	const match = tail.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/u);
	if (!match) return { names: tail };
	return { names: match[1].trim(), song: match[2].trim() };
}

/** Splits a featured-artist list on commas, Japanese commas and " & ". */
function splitArtistList(raw: string): string[] {
	return raw
		.split(/\s*[，,]\s*|\s+&\s+/)
		.map((name) => name.trim())
		.filter(Boolean);
}

/** Joins a featured-artist list back to "A, B & C". */
export function joinArtists(feats: string[]): string {
	if (feats.length <= 2) return feats.join(" & ");
	return `${feats.slice(0, -1).join(", ")} & ${feats[feats.length - 1]}`;
}

const BRACKET_OPEN = String.raw`[(（【\[]`;
const BRACKET_CLOSE = String.raw`[)）】\]]`;
const COVER_MARKER =
	BRACKET_OPEN +
	String.raw`\s*(?:\w+\s+)?cover(?:ed)?(?:\s+(?:by\s+.{1,60}?|version|ver\.?))?` +
	BRACKET_CLOSE;

/** A bare bracketed cover marker: "(Cover)", "【covered】" (no qualifiers). */
const COVER_BRACKET =
	String.raw`\s*` +
	BRACKET_OPEN +
	String.raw`\s*cover(?:ed)?\s*` +
	BRACKET_CLOSE;

/**
 * Whether a split credit entry is a marker or descriptor rather than a name —
 * "歌ってみた", "少し演奏してみた" ("played a little"), "カバー", "cover",
 * "１人で" ("solo").
 */
function isMarkerEntry(entry: string): boolean {
	const name = entry.trim();
	if (name === "") return true;
	if (/^(?:cover(?:ed|s)?|カバー)$/iu.test(name)) return true;
	if (/(?:って|して)みた$/u.test(name)) return true;
	return /^(?:１人|1人|一人|ひとり|独り|ソロ)(?:で)?$/u.test(name);
}

/**
 * Splits a cover-credit artist list on slashes, commas and ampersands, drops
 * bracketed decorators per entry ("桃鈴ねね(cover)", "博衣こより(hololive)")
 * and keeps only the actual names of mixed marker lists
 * ("歌ってみた/ときのそら" → "ときのそら").
 */
function splitCoverArtists(raw: string): string[] {
	return raw
		.split(/\s*[，,、]\s*|\s*[/／]\s*|\s*＆\s*|\s+&\s+|\s*[×✕]\s*/u)
		.map((name) => artistCore(name).trim())
		.filter((name) => name !== "" && name.length <= 60 && !isMarkerEntry(name));
}

/**
 * "藍月なくる×DECO*27×tepe「Hookah, whoo!」MV / ゲーム『Hookah Haze』主題歌"
 * — a leading "A×B×C" performer list with the song title quoted after it.
 * Matches through the closing quote.
 */
const LEADING_PERFORMER_QUOTE =
	/^([^「『]{1,80}?[×✕][^「『]{0,60}?)\s*[「『](.+?)[」』]/u;

/**
 * The performers and song title of the leading-list shape (see
 * LEADING_PERFORMER_QUOTE), or null when the title doesn't use it.
 */
export function splitLeadingPerformers(title: string): {
	performers: string[];
	title: string;
} | null {
	const match = title.match(LEADING_PERFORMER_QUOTE);
	if (!match) return null;
	const performers = splitCoverArtists(match[1]);
	if (performers.length < 2) return null;
	return { performers, title: match[2].trim() };
}

/** Patterns whose capture is the performer list of a cover credit. */
const COVER_CREDIT_PATTERNS: RegExp[] = [
	// "(covered by X)" / "【cover by X】"
	/[(（【[]\s*cover(?:ed)?\s+by\s+([^)）】\]]{1,80}?)\s*[)）】\]]/iu,
	// "… (Cover) / VESPERBELL ヨミ" — the marker followed by the performers
	// after a slash.
	new RegExp(COVER_BRACKET + String.raw`\s*[/／]\s*([^【[]+).*$`, "iu"),
	// "covered by X" tail, up to a trailing tag bracket
	/(?<![\p{L}(（【[])\s*cover(?:ed)?\s+by\s*([^【[]+).*$/iu,
	// "… /Cover <artist list>" tail
	/\s*[/／]\s*cover(?:ed)?\s+(?!by\b)([^【[]+).*$/iu,
	// "<song> <A×B>(cover)" — performers before the cover marker
	new RegExp(
		String.raw`^\s*.+?\s+([^\s(（【[\]×✕]+(?:\s*[×✕]\s*[^\s(（【[\]×✕]+)+)\s*` +
			COVER_MARKER +
			String.raw`\s*$`,
		"iu",
	),
];

/**
 * "flos (Remix ver.) / R Sound Design - むﾄ (cover)" — the dash-credited
 * performer right before the cover marker. Only used when the title doesn't
 * start with the artist, where the dash is the "Artist - Song" prefix.
 */
const DASH_COVER_CREDIT = new RegExp(
	String.raw`\s+-\s+([^-(（【[\]]{1,60}?)\s*` + COVER_MARKER + String.raw`\s*$`,
	"iu",
);

/**
 * Trailing tag bracket holding a performer list, e.g. "【神楽めあ× 湊あくあ】"
 * — cover videos credit the singers there after the title.
 */
const TRAILING_TAG_LIST =
	/\s*[【『「《〈≪]\s*([^【『「《〈≪】』」》〉≫]+?)\s*[】』」》〉≫]\s*$/u;

/**
 * Pulls the extra performer names out of the title — a cover credit
 * ("covered by A & B", "(cover by A)", "… /Cover A/B", "…(Cover) / A",
 * "…【A×B】") or a leading "A×B「Song」" artist list — so the artist row can
 * list them. Requiring two names in a trailing bracket keeps single
 * channel/group tags ("【FUWAMOCO】") out.
 */
function extractCoverArtists(title: string, artist?: string): string[] {
	for (const pattern of COVER_CREDIT_PATTERNS) {
		const match = title.match(pattern);
		if (!match) continue;
		const artists = splitCoverArtists(match[1]);
		if (artists.length > 0) return artists;
	}
	// "藍月なくる×DECO*27×tepe「Hookah, whoo!」MV" — the leading list names
	// the track's performers.
	const leading = splitLeadingPerformers(title);
	if (leading) return leading.performers;
	const list = title.match(TRAILING_TAG_LIST);
	if (list) {
		const artists = splitCoverArtists(list[1]);
		if (artists.length >= 2) return artists;
	}
	// "Artist - Song (cover)" is a prefix credit, not a performer list.
	if (!titleCreditsArtist(title, artist)) {
		const dash = title.match(DASH_COVER_CREDIT);
		if (dash) {
			const artists = splitCoverArtists(dash[1]);
			if (artists.length > 0) return artists;
		}
	}
	return [];
}

/**
 * Whether the title leads with the artist's name — matched in full or by the
 * artist's leading word, since titles credit "Bao The Whale" as "Bao - Song".
 */
function titleCreditsArtist(title: string, artist?: string): boolean {
	const primary = artist?.trim();
	if (!primary || primary.length > 60) return false;
	const folded = title.toLowerCase();
	if (folded.startsWith(primary.toLowerCase())) return true;
	const lead = primary.split(/\s+/)[0]?.toLowerCase();
	// A word boundary keeps lookalikes ("Baofu - …") out.
	return (
		lead !== undefined &&
		lead.length >= 3 &&
		(folded.startsWith(`${lead} `) || folded.startsWith(`${lead}-`))
	);
}

/**
 * Strips credit authors the artist row already shows: when every name of a
 * pill author ("ときのそら & ホロライブ") is among the parsed cover performers,
 * the pill drops back to a plain "Cover".
 */
function dropRedundantAuthors(
	credits: TitleCredit[],
	coverArtists: string[],
): TitleCredit[] {
	if (coverArtists.length === 0) return credits;
	const known = new Set(coverArtists.map((name) => name.toLowerCase()));
	return credits.map((credit) => {
		if (!credit.author) return credit;
		const names = credit.author
			.split(/\s*&\s*|\s*,\s*/u)
			.map((name) => name.trim())
			.filter(Boolean);
		return names.length > 0 &&
			names.every((name) => known.has(name.toLowerCase()))
			? { tag: credit.tag }
			: credit;
	});
}

/**
 * Full title pipeline: credit extraction → noise cleanup → artist-prefix
 * strip → feat-tail extraction → dual-title mode. Returns the display main
 * title, featured artists (styled separately), credit pills and the cover
 * performers parsed from the title.
 */
export function formatTitleParts(
	title: string,
	mode: TitleMode,
	clean = false,
	artist?: string,
): {
	main: string;
	feats: string[];
	credits: TitleCredit[];
	coverArtists: string[];
} {
	let credits: TitleCredit[] = [];
	let coverArtists: string[] = [];
	// Cover evidence is read from the raw title: credit extraction removes
	// the very marker ("【covered by …】") the flavor-bracket strip keys on.
	const coverContext = COVER_CONTEXT.test(title);
	if (clean) {
		coverArtists = extractCoverArtists(title, artist);
		const extracted = extractCredits(title);
		credits = dropRedundantAuthors(extracted.credits, coverArtists);
		title = extracted.title;
		// "Bao - girls like me don't cry (cover)": shed an artist prefix
		// before the cover cleanup would mistake the song for the performer
		// ("Song - Performer (cover)" shape).
		title = stripArtistPrefix(title, artist, credits);
		title = cleanUpTitle(title, coverContext);
		title = stripArtistPrefix(title, artist, credits);
		title = stripArtistSuffix(title, artist);
	}
	// Re-clean the main title: noise hidden behind the feat tail
	// ("HOP HOP (Music Video) - ft. X") only becomes a tail after the split.
	const split = splitFeaturedTitle(title);
	const main = clean ? cleanUpTitle(split.main, coverContext) : split.main;
	return {
		main: applyMode(main, mode),
		feats: split.feats,
		credits,
		coverArtists,
	};
}

/** Remix authors credited by the title ("… (Pat B remix)"), in credit order. */
export function remixAuthors(credits: TitleCredit[]): string[] {
	return credits.flatMap((credit) =>
		credit.tag === "remix" && credit.author ? [credit.author] : [],
	);
}

/**
 * Single-string variant (e.g. Discord presence); the feat and remix tails
 * stay inline.
 */
export function displayTitle(
	title: string,
	mode: TitleMode,
	clean = false,
	artist?: string,
): string {
	const { main, feats, credits } = formatTitleParts(title, mode, clean, artist);
	let out = feats.length > 0 ? `${main} (feat. ${joinArtists(feats)})` : main;
	const remix = remixAuthors(credits);
	if (remix.length > 0) out += ` (${joinArtists(remix)} remix)`;
	return out;
}

/**
 * Prepares a title for external search (MusicBrainz): runs the full original-
 * mode pipeline — noise/decoration cleanup, artist prefix, feat tail, dual-
 * title resolution — so the query carries only the original song name.
 */
export function cleanSearchTitle(title: string, artist?: string): string {
	return formatTitleParts(title, "original", true, artist).main;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strips leading artist credits from the title. Three conventions:
 * "<artist> - Song" (e.g. "Chenomio -フィクションです。feat.重音テト"),
 * comma/ampersand chains — "Dutch Disorder, Cryogenic, & Unlocked, Heroine" —
 * and a leading name tag in 【】 ("【ちくわ】人生マタタビ" for ちくわちゃんねる).
 * Chain segments must be the primary artist or a name found inside the
 * extracted credit authors, so unknown text (the actual song) ends the strip.
 */
export function stripArtistPrefix(
	title: string,
	artist?: string,
	credits?: TitleCredit[],
): string {
	const primary = artist?.trim();
	if (!primary || primary.length > 60) return title;
	// The title may credit the artist by a short form: the decorator-stripped
	// name ("Kobo Kanaeru Ch. hololive" → "Kobo Kanaeru - Overdose") or the
	// artist's leading word ("Bao The Whale" → "Bao - girls like me don't cry").
	const candidates = [primary];
	const decorated = formatArtistName(primary);
	if (decorated && decorated !== primary) candidates.push(decorated);
	const lead = primary.split(/\s+/)[0];
	if (lead && lead !== primary && lead.length >= 3) candidates.push(lead);

	// "【<artist>】Song": a channel tags its own uploads with its name
	// ("ちくわちゃんねる" → "【ちくわ】人生マタタビ"). Only a bracket whose
	// content is one of the name candidates is an artist tag.
	let out = title;
	const tag = out.match(/^\s*【([^【】]{1,40}?)】\s*/u);
	const tagContent = tag?.[1].trim();
	if (
		tag &&
		tagContent &&
		candidates.some((name) => foldName(name) === foldName(tagContent))
	) {
		const next = out.slice(tag[0].length).trim();
		if (next !== "") out = next;
	}

	const matched = candidates.find((name) =>
		out.toLowerCase().startsWith(name.toLowerCase()),
	);
	if (!matched) return out;

	// Names that may lead the title as credits: the primary artist plus
	// every name found inside the extracted credit authors.
	const known = new Set<string>([primary.toLowerCase()]);
	for (const credit of credits ?? []) {
		if (!credit.author) continue;
		for (const name of credit.author.split(
			/\s*feat\.?\s*|\s*&\s*|\s*,\s*|\s+/i,
		)) {
			if (name.length >= 3 && name.length <= 60) {
				known.add(name.toLowerCase());
			}
		}
	}

	// "<artist> - Song" convention.
	out = out
		.replace(new RegExp(`^${escapeRegExp(matched)}\\s*[-–—]\\s*`, "i"), "")
		.trim();
	// "<artist>, <name>, & <name>, Song" credit list convention.
	for (;;) {
		out = out.replace(/^[，&]\s+/, "");
		const segment = out.match(/^([^,，&]{1,60}?)\s*[,，&]\s*/);
		if (!segment) break;
		if (!known.has(segment[1].trim().toLowerCase())) break;
		const next = out.slice(segment[0].length).trim();
		if (next === "" || next === out) break;
		out = next;
	}
	return out === "" ? title : out;
}

/** Folds a name for fuzzy comparison: lowercase, no spaces or punctuation. */
function foldName(text: string): string {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Drops bracketed group tags from an artist ("Elira Pendora 【NIJISANJI EN】"). */
function artistCore(name: string): string {
	return name
		.replace(/[([（【『「〈≪][^)）】』」〉≫\]]*[)）】』」〉≫\]]/gu, " ")
		.trim();
}

/**
 * Drops bracketed group tags for display ("Elira Pendora 【NIJISANJI EN】" →
 * "Elira Pendora") but keeps credit brackets naming a person, which carry a
 * role ("Ellen Joe (CV:Shion Wakayama)").
 */
function dropGroupTags(name: string): string {
	return name
		.replace(/[([（【『「〈≪][^)）】』」〉≫\]]*[)）】』」〉≫\]]/gu, (match) =>
			/[：:]/u.test(match) ? match : " ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Strips a trailing artist credit that mirrors the track's artist —
 * "もぐもぐYUMMY！ - 猫又おかゆ" or "… (Nerissa Ravencroft)" when the
 * artist is 猫又おかゆ / Nerissa Ravencroft. Only strips when a non-empty
 * title remains, so "Artist - Song" pairs handled by stripArtistPrefix are
 * untouched.
 */
export function stripArtistSuffix(title: string, artist?: string): string {
	const primary = artist?.trim();
	if (!primary || primary.length > 60) return title;
	// Group tags ("Elira Pendora 【NIJISANJI EN】") would otherwise break the
	// fuzzy match, so also try the name with its bracketed segments dropped.
	const targets = [foldName(primary), foldName(artistCore(primary))].filter(
		(target) => target.length >= 2,
	);
	if (targets.length === 0) return title;
	const matches = (segment: string) => {
		const folded = foldName(segment);
		if (folded.length < 2) return false;
		return targets.some(
			(target) =>
				folded === target || folded.includes(target) || target.includes(folded),
		);
	};

	// "(<artist>)" / "【<artist>】" tail.
	const bracket = title.match(
		/\s*([（(【[])([^（）()【】[\]]{1,80})([）)】\]])\s*$/u,
	);
	if (bracket && matches(bracket[2])) {
		const head = title.slice(0, bracket.index ?? 0).trim();
		if (head) return head;
	}
	// " - <artist>" / "/ <artist>" / "／<artist>" tail.
	const separated = title.match(
		/\s*(?:[-–—]\s*|\s*\/\s*|／)([^-–—／/]{1,80})$/u,
	);
	if (separated && matches(separated[1])) {
		const head = title.slice(0, separated.index ?? 0).trim();
		if (head) return head;
	}
	return title;
}

/**
 * Noise YouTube/labels append to titles, stripped when title cleanup is
 * enabled. Regex entries are removed; object entries are rewritten to their
 * replacement (group captures keep the wanted part). Extend this list as
 * more patterns show up.
 */
type NoiseRule = RegExp | { pattern: RegExp; replacement: string };

/** Bare "歌ってみた" marker, optionally carrying a "Ver.<performer>" credit. */
const BARE_COVER_MARKER =
	/\s*[歌弾踊叩]ってみた(?:\s*ver(?:sion)?\.?\s*\S{1,60})?\s*$/iu;

const TITLE_NOISE: NoiseRule[] = [
	// "藍月なくる×DECO*27×tepe「Hookah, whoo!」MV / ゲーム『Hookah Haze』
	// 主題歌" → "Hookah, whoo! …" — the quoted song title replaces the
	// leading performer list; the MV marker and slash credit peel afterwards.
	{
		pattern: LEADING_PERFORMER_QUOTE,
		replacement: "$2 ",
	},
	// "美人局 (covered by 藍月なくる)" → "美人局" (also full-width brackets)
	new RegExp(
		String.raw`\s*` +
			BRACKET_OPEN +
			String.raw`\s*cover(?:ed)?\s+by\s*.{1,60}?` +
			BRACKET_CLOSE +
			String.raw`\s*$`,
		"i",
	),
	// "美人局 covered by 藍月なくる" / "BANG!BANG!BANG!/Covered by癒月ちょこ" /
	// "【チューリングラブ// Turing Love】Cover by Pomu Rainpuff" → song only.
	// Opening brackets are left to the rule above; a preceding letter (e.g.
	// "undercover") blocks the match.
	/(?<![\p{L}(（【[])\s*cover(?:ed)?\s+by.*$/iu,
	// "メンヘラじゃないもん！ /Cover 湊あくあ/紫咲シオン【ホロライブ】" →
	// "メンヘラじゃないもん！" — a slash-attached "Cover <artist list>" tail
	// (the "covered by …" form is owned by the rule above).
	/\s*[/／]\s*cover(?:ed)?\s+(?!by\b).*$/iu,
	// "「クノイチでも恋がしたい」歌ってみた" / "夜撫でるメノウ　歌ってみた
	// Ver.湊あくあ" → song only; an optional "Ver.<performer>" credit goes
	// with the marker.
	BARE_COVER_MARKER,
	// "Invincible Rainbow Arrow (English Cover) ／ver. …" →
	// "Invincible Rainbow Arrow ／ver. …" — language-cover markers are noise
	// wherever they appear, not just at the end.
	new RegExp(
		String.raw`\s*` +
			BRACKET_OPEN +
			String.raw`\s*(?:english|japanese|korean|chinese|mandarin)\s+cover(?:ed)?\s*` +
			BRACKET_CLOSE,
		"i",
	),
	// "flos (Remix ver.) / …" → "flos / …" — an author-less remix version
	// marker. Stripping it lets the Remix pill (detectTitleTags) show on the
	// cleaned title; author-carrying remixes are already credits by now.
	new RegExp(
		String.raw`\s*` +
			BRACKET_OPEN +
			String.raw`\s*(?:remix|rmx)\s*(?:ver(?:sion)?\.?)?\s*` +
			BRACKET_CLOSE,
		"i",
	),
	// "flos (Remix ver.) / R Sound Design - むﾄ (cover)" → "flos"
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?)\s*/\s*.{1,60}\s+-\s+.{1,60}?` +
				COVER_MARKER +
				String.raw`\s*$`,
			"i",
		),
		replacement: "$1",
	},
	// "flos - むﾄ (cover)" → "flos"
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?)\s+-\s+.{1,60}?` + COVER_MARKER + String.raw`\s*$`,
			"i",
		),
		replacement: "$1",
	},
	// "flos / R Sound Design (cover)" → "flos"
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?)\s*/\s*.{1,60}?` + COVER_MARKER + String.raw`\s*$`,
			"i",
		),
		replacement: "$1",
	},
	// "ダーリンダンス 湊あくあ×猫又おかゆ(cover)" → "ダーリンダンス" —
	// a space-separated "A×B" performer list right before the cover marker.
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?)\s+` +
				String.raw`[^\s(（【[\]×✕]+(?:\s*[×✕]\s*[^\s(（【[\]×✕]+)+` +
				String.raw`\s*` +
				COVER_MARKER +
				String.raw`\s*$`,
			"iu",
		),
		replacement: "$1",
	},
	// "SPECIALZ - King Gnu (Cover) / VESPERBELL ヨミ" → "SPECIALZ" — the
	// "Song - OriginalArtist (Cover) / Performer" form: the dash credit and
	// the slash performers both belong to the cover, not the title.
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?)\s+[-–—]\s+[^-–—/／]{1,60}?` +
				COVER_BRACKET +
				String.raw`\s*[/／]\s*[^【[]+.*$`,
			"iu",
		),
		replacement: "$1",
	},
	// "月陽 -ツキアカリ-  みきとP (Cover) / VESPERBELL" → "月陽 -ツキアカリ-"
	// — the dash-separated form without a space before the dash: a non-Latin
	// name right after a trailing dash is the original artist.
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?[-–—])\s+\S*[^\s\p{Script=Latin}\p{N}\p{P}\p{S}]\S*` +
				COVER_BRACKET +
				String.raw`\s*[/／]\s*[^【[]+.*$`,
			"iu",
		),
		replacement: "$1",
	},
	// "Night Dancer (cover)" / "残酷な天使のテーゼ (Cover) / 花譜" → song
	// only — the marker with an optional slash-credited performer list.
	new RegExp(COVER_BRACKET + String.raw`\s*(?:[/／]\s*[^【[]+.*)?$`, "i"),
	// "モエチャッカファイア (弌誠) ／ダズビー COVER" → "モエチャッカファイア"
	// — the parenthesized name right before a slash cover credit names the
	// original, not the cover. Feature/version parens are left to later rules.
	{
		pattern: new RegExp(
			String.raw`^(.{1,80}?)\s*[(（]` +
				String.raw`(?!\s*(?:feat|ft|ver|version|remix|inst|instrumental|cover(?:ed)?|official|mv|m\/v|pv|lyrics?|from)\b)` +
				String.raw`[^()（）]{1,40}[)）]\s*[/／]\s*[^/／]{1,60}?` +
				String.raw`\s*(?:cover(?:ed)?|カバー|[歌弾踊叩]ってみた)\s*$`,
			"iu",
		),
		replacement: "$1",
	},
	// "デーモンロード/ Kanaria 【オリジナルMV】cover" → bare trailing word,
	// only right after a CJK bracket/script so "Take Cover" survives
	/(?<=[)）\]】』」》〉≫]|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana})\s*\bcover(?:ed|s)?\s*$/iu,
	// 'Lumiose City (From "Pokémon X & Y")' → "Lumiose City"
	new RegExp(
		String.raw`\s*` +
			BRACKET_OPEN +
			String.raw`\s*from\s+(?:"[^"]{1,80}"|“[^”]{1,80}”|.{1,80}?)` +
			BRACKET_CLOSE +
			String.raw`\s*$`,
		"i",
	),
];

/**
 * Cover-credit evidence ("歌ってみた", a cover word, "カバー") — when the
 * video is a cover, leading flavor brackets like "【可愛く】" are video tags
 * rather than part of the song title, so they can be stripped.
 */
const COVER_CONTEXT = /[歌弾踊叩]ってみた|\bcover(?:ed|s)?\b|カバー/iu;

/**
 * Strips known noise from the end of a title; never empties it. The rules
 * are applied to a fixpoint so patterns revealed by an earlier peel (e.g.
 * "(Cover)" after a trailing 【channel】 bracket) are also removed.
 * `coverContext` can be supplied by the caller when the cover evidence was
 * already extracted from the title ("【covered by …】"), so leading flavor
 * brackets are still recognized as video tags.
 */
export function cleanUpTitle(
	title: string,
	coverContext = COVER_CONTEXT.test(title),
): string {
	let out = title;
	for (;;) {
		const before = out;
		for (const rule of TITLE_NOISE) {
			out =
				typeof rule === "object" && "replacement" in rule
					? out.replace(rule.pattern, rule.replacement)
					: out.replace(rule, "");
		}
		out = stripDecorations(out, coverContext);
		out = stripCreditTail(out);
		out = collapseRepeatedHalves(out);
		if (out === before) break;
	}
	return out.trim() === "" ? title : out.trim();
}

/**
 * Collapses a title stylized as the same name twice — "WataAme Pop - Wata
 * Ame Pop" → "WataAme Pop". The halves must fold to the same text (case,
 * spacing and punctuation ignored), so real "Artist - Song" pairs stay.
 */
function collapseRepeatedHalves(title: string): string {
	const match = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
	if (!match) return title;
	const left = match[1].trim();
	const right = match[2].trim();
	if (left.length < 2 || right.length < 2) return title;
	return foldName(left) === foldName(right) ? left : title;
}

/**
 * "セレナーデ / なとり" and "snooze／眠雲ツクリ" → left side: a single
 * " / "/"／" separator followed by a same-script segment is an
 * uploader/artist credit. Translation-style pairs ("夜駆け / Night Run") and
 * version tags are left for the dual-title mode; multiple separators suggest
 * a medley and are kept. Glued-slash credits ("ラッシャイナ/柊マグネタイト",
 * "デーモンロード/ Kanaria") are handled separately: the right side must be
 * a single short token, which translation halves rarely are.
 */
function stripCreditTail(title: string): string {
	const idx = Math.max(title.lastIndexOf(" / "), title.lastIndexOf("／"));
	if (idx > 0) {
		const separator = title.startsWith("／", idx) ? "／" : " / ";
		if (title.indexOf(separator) !== idx) return title;
		const left = title.slice(0, idx).trim();
		const right = title.slice(idx + separator.length).trim();
		if (!left || !right || right.length > 60) return title;
		// "Song ／ver. Elira Pendora" — a version/performer credit, not a
		// translation pair, even though the right side is Latin-only.
		if (/^(?:ver(?:sion)?|cv)\b/i.test(right)) return left;
		if (LATIN_ONLY.test(right)) return title;
		if (
			/\b(?:ver|version|remix|full|short|inst|instrumental|off\s+vocal)\b/i.test(
				right,
			)
		) {
			return title;
		}
		return left;
	}
	return stripGluedSlashCredit(title);
}

/** "ラッシャイナ/柊マグネタイト" → "ラッシャイナ" (glued-slash credit). */
function stripGluedSlashCredit(title: string): string {
	const idx = title.lastIndexOf("/");
	if (idx <= 0 || title.indexOf("/") !== idx) return title;
	const left = title.slice(0, idx).trimEnd();
	const right = title.slice(idx + 1).trim();
	if (!left || left.length < 3 || !right) return title;
	if (right.length > 60 || /\s/.test(right)) return title;
	if (
		/\b(?:ver|version|remix|full|short|inst|instrumental|off\s+vocal)\b/i.test(
			right,
		)
	) {
		return title;
	}
	return left;
}

/* ─── Decorative tails (MV markers, tag brackets, hashtags) ───── */

/** Decorative bracket pairs used as emphasis/tags (full-width and ASCII). */
const DECOR_OPEN = String.raw`【『「《〈≪\[`;
const DECOR_CLOSE = String.raw`】』」》〉≫\]`;

/**
 * Trailing hashtag run, e.g. "Song #tag". The tag body stops at brackets:
 * Japanese titles have no spaces, so a greedy "\S+" would swallow the rest
 * of the title through a bracket ("【#tag】Song" → "【").
 */
const HASHTAG_TAIL = new RegExp(
	String.raw`(?:\s*#[^\s#` +
		DECOR_OPEN +
		DECOR_CLOSE +
		String.raw`(){}]+)+\s*$`,
	"u",
);
const TAG_TAIL = new RegExp(
	String.raw`\s*[` +
		DECOR_OPEN +
		"][^" +
		DECOR_OPEN +
		DECOR_CLOSE +
		"]*[" +
		DECOR_CLOSE +
		"]\\s*$",
);
/** Title fully wrapped in one tag bracket, e.g. "【チューリングラブ】". */
const SOLE_TAG_BRACKET = new RegExp(
	String.raw`^\s*[` +
		DECOR_OPEN +
		"]([^" +
		DECOR_OPEN +
		DECOR_CLOSE +
		"]*)[" +
		DECOR_CLOSE +
		String.raw`]\s*$`,
);
// "MV", "Music Video", … — only after a boundary so "ЯMV" survives.
const VIDEO_MARKER_TAIL =
	/(?<=[\s)）\]】』〉」\-–—/|｜·・]|^)\s*(?:M\/V|MV|Music\s+Video|Official\s+(?:Music\s+)?Video)\s*$/i;
// A trailing separator left dangling by an earlier peel ("Song -", "Song /")
// is dropped, but a dash that closes a dash-wrapped run glued to the title
// ("月陽 -ツキアカリ-") stays: a peel never leaves that shape behind.
const SEPARATOR_TAIL = /(?<![-–—][^\s]{1,30})[-–—/|｜·・／]\s*$/;

/** Leading decorative tag brackets carrying video/cover keywords. */
const LEADING_TAG_BRACKET =
	/^\s*([【『「《〈≪])([^【』「」《》〈〉≪≫]{1,40})([】』」》〉≫])/u;
const LEADING_TAG_KEYWORD =
	/(?:\b(?:mv|m\/v|pv|official|cover(?:ed)?|original|music\s+video|lyrics?)\b|[歌弾踊叩]ってみた|オリジナル|リリック)/i;

/** Trailing plain paren group, e.g. "(Official Video)". */
const QUALIFIER_PAREN_TAIL = /\s*[(（]([^()（）[\]【】]{1,80})[）)]\s*$/u;
/** Trailing dash/slash group, e.g. "- English Cover". */
const QUALIFIER_SEPARATED_TAIL = /\s*[-–—/／]\s*([^-–—/／]{1,40})$/u;
const QUALIFIER_TOKEN =
	/^(?:official|music|video|mv|m\/v|pv|mashup|edm|lyrics?|visualizer|amv|english|japanese|korean|chinese|mandarin|cover(?:ed|s)?)$/i;

/** Every space-separated token of the group is video/qualifier noise. */
function isQualifierRun(content: string): boolean {
	const tokens = content
		.trim()
		.split(/[\s/・,，]+/)
		.filter(Boolean);
	return tokens.length > 0 && tokens.every((t) => QUALIFIER_TOKEN.test(t));
}

/**
 * Peels decoration layers off the title end, e.g.
 * "失楽園 - Paradise Lost -『 失楽園 』MV【 #VocaDuo2026 】" →
 * "失楽園 - Paradise Lost". Strips hashtags, video markers and decorative
 * bracket pairs, then dangling separators. Also drops leading tag brackets
 * ("【MV】怪物…" → "怪物…" and, for cover videos, flavor tags like
 * "【可愛く】") and trailing qualifier groups
 * ("Idols (EDM Mashup) (Official Video)" → "Idols",
 * "G4L - English Cover" → "G4L").
 */
/** Unwraps "【song】"/"「song」" when the pair wraps the whole title. */
function unwrapSoleBracket(text: string): string {
	const sole = text.match(SOLE_TAG_BRACKET);
	return sole?.[1].trim() && !LEADING_TAG_KEYWORD.test(sole[1])
		? sole[1].trim()
		: text;
}

function stripDecorations(title: string, coverContext = false): string {
	let out = title.replace(HASHTAG_TAIL, "");
	for (;;) {
		out = unwrapSoleBracket(out);
		const next = unwrapSoleBracket(
			out
				.replace(VIDEO_MARKER_TAIL, "")
				.replace(TAG_TAIL, "")
				// Peel a bare marker here too: it can hide behind a trailing
				// bracket ("…「song」歌ってみた【cast】") and must be gone before
				// the wrapping bracket is judged as decoration.
				.replace(BARE_COVER_MARKER, ""),
		)
			.replace(LEADING_TAG_BRACKET, (match, _open, content: string) =>
				LEADING_TAG_KEYWORD.test(content) || coverContext ? "" : match,
			)
			.replace(QUALIFIER_PAREN_TAIL, (match, content: string) =>
				isQualifierRun(content) ? "" : match,
			)
			.replace(QUALIFIER_SEPARATED_TAIL, (match, content: string) =>
				isQualifierRun(content) ? "" : match,
			)
			.trimEnd();
		if (next === out) break;
		out = next;
	}
	return out.replace(SEPARATOR_TAIL, "").trimEnd();
}

/**
 * Settings-bound title formatter for plain-string display sites. `keepTitle`
 * is for uploader videos, whose raw "Original - Translation"-shaped title is
 * shown whole — the title mode doesn't apply to them.
 */
export function useDisplayTitle(): (
	title: string,
	keepTitle?: boolean,
) => string {
	const [settings] = useSettings();
	return useCallback(
		(title: string, keepTitle = false) =>
			displayTitle(
				title,
				keepTitle ? "both" : settings.titleMode,
				settings.cleanTitles,
			),
		[settings.cleanTitles, settings.titleMode],
	);
}

/**
 * Settings-bound variant that keeps feats and credits separate; `keepTitle`
 * behaves as in `useDisplayTitle`.
 */
export function useFormatTitle(): (
	title: string,
	artist?: string,
	keepTitle?: boolean,
) => {
	main: string;
	feats: string[];
	credits: TitleCredit[];
	coverArtists: string[];
} {
	const [settings] = useSettings();
	return useCallback(
		(title: string, artist?: string, keepTitle = false) =>
			formatTitleParts(
				title,
				keepTitle ? "both" : settings.titleMode,
				settings.cleanTitles,
				artist,
			),
		[settings.cleanTitles, settings.titleMode],
	);
}

/* ─── Song tags (cover / remix / edit chips) ──────────────────── */

export type TitleTag = "cover" | "remix" | "edit";

export interface TitleCredit {
	tag: TitleTag;
	author?: string;
}

const TAG_PATTERNS: Record<TitleTag, RegExp> = {
	// 歌ってみた (and 弾/踊/叩ってみた) = "tried singing/playing/dancing" covers.
	cover: /\bcover(?:ed|s)?\b|[歌弾踊叩]ってみた/i,
	remix: /\bremix(?:es|ed)?\b|\brmx\b|\bbootleg\b/i,
	edit: /\bedit(?:ed)?\b/i,
};

/** Classifies a raw title as a cover and/or remix. */
export function detectTitleTags(title: string): TitleTag[] {
	return (Object.keys(TAG_PATTERNS) as TitleTag[]).filter((tag) =>
		TAG_PATTERNS[tag].test(title),
	);
}

/** Bracket pairs recognized when scanning for credit segments. */
const BRACKET_PAIRS: Record<string, string> = {
	"(": ")",
	"[": "]",
	"（": "）",
	"【": "】",
	"{": "}",
	"『": "」",
	"「": "」",
	"〈": "〉",
	"≪": "≫",
};
const ANY_BRACKET = /[()（）[\]{}【】『「〈≪』」〉≫]/;

/** Yields every bracket group (outermost and nested) of the title. */
function* bracketSegments(title: string): Generator<{
	content: string;
	start: number;
	end: number;
}> {
	const stack: Array<{ open: string; start: number }> = [];
	for (let i = 0; i < title.length; i++) {
		const ch = title[i];
		if (BRACKET_PAIRS[ch] !== undefined) {
			stack.push({ open: ch, start: i });
		} else if (stack.length > 0 && Object.values(BRACKET_PAIRS).includes(ch)) {
			const top = stack.pop();
			if (top && BRACKET_PAIRS[top.open] === ch) {
				yield {
					content: title.slice(top.start + 1, i),
					start: top.start,
					end: i + 1,
				};
			}
		}
	}
}

const QUALIFIER_WORDS =
	/^(?:english|japanese|korean|chinese|mandarin|full|short|extended|nightcore|sped|slowed|reverb|lofi|acoustic|instrumental|official|bonus|deluxe|fan|mashup|vocal|off|karaoke|ver|version|tv|movie|game|demo)\b/i;

/** Extracts the credit author from a bracket segment, if it carries one. */
function creditFromContent(content: string): TitleCredit | null {
	for (const tag of Object.keys(TAG_PATTERNS) as TitleTag[]) {
		if (!TAG_PATTERNS[tag].test(content)) continue;
		const remainder = content
			.replace(TAG_PATTERNS[tag], "")
			.replace(/\bby\b/i, "")
			.replace(/\bver(?:sion)?\.?/i, "")
			.trim()
			.replace(/^[\s\-–—:：·・/／]+|[\s\-–—:：·・/／]+$/g, "");
		if (!remainder || remainder.length > 60) return null;
		// "Caine & GPF's 200BPM Donk … Remix": the possessive names the
		// remixer, the rest is the remix's own title.
		const possessor = remainder.match(/^(.{2,40}?)[’']s\b/u)?.[1]?.trim();
		// "Cover/１人で" / "歌ってみた/少し演奏してみた/ときのそら/ホロライブ":
		// keep name segments only. Marker-only remains yield no author — the
		// generic Cover pill still shows via detectTitleTags.
		const names = (possessor || remainder)
			.split(/\s*(?:[/／、,，]|\s+&\s+|&)\s*/u)
			.map((name) => name.trim())
			.filter((name) => name !== "" && !isMarkerEntry(name));
		if (names.length === 0 || QUALIFIER_WORDS.test(names[0])) return null;
		const author = joinArtists(names);
		if (author.length > 40) return null;
		return { tag, author };
	}
	return null;
}

/**
 * Pulls author-carrying credit brackets out of the title —
 * "Heroine ((Pat B remix) [TOZA Edit])" → "Heroine" + Remix·Pat B, Edit·TOZA.
 * Author-less segments ("(cover)", "(Remix ver.)") are left for the noise
 * rules so their display behavior stays unchanged.
 */
function extractCredits(title: string): {
	title: string;
	credits: TitleCredit[];
} {
	const credits: TitleCredit[] = [];
	const removals: Array<{ start: number; end: number }> = [];
	for (const segment of bracketSegments(title)) {
		if (ANY_BRACKET.test(segment.content)) continue; // nested — not a leaf
		const credit = creditFromContent(segment.content);
		if (!credit) continue;
		// Duplicate credit (e.g. "(… Edit) (feat. … Edit)" from the catalog):
		// when a same-tag credit already covers this author, drop silently.
		const duplicate = credits.some(
			(existing) =>
				existing.tag === credit.tag &&
				existing.author !== undefined &&
				credit.author !== undefined &&
				(credit.author.toLowerCase().includes(existing.author.toLowerCase()) ||
					existing.author.toLowerCase().includes(credit.author.toLowerCase())),
		);
		if (duplicate || credit.author) {
			if (!duplicate) credits.push(credit);
			removals.push({ start: segment.start, end: segment.end });
		}
	}
	let out = title;
	for (const removal of removals.reverse()) {
		out = out.slice(0, removal.start) + out.slice(removal.end);
	}
	// Collapse bracket pairs emptied by the removals, e.g. "Heroine ( )".
	out = out.replace(/\s*[(（【[{『「〈≪]\s*[)）】\]}』」〉≫]\s*/g, " ").trim();
	return { title: out, credits };
}
