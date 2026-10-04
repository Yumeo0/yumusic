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
	}
	// Bare trailing marker: "カグラナナchannel" → "カグラナナ".
	const trailing = name.match(CHANNEL_MARKER);
	if (trailing?.index) {
		const head = name.slice(0, trailing.index).trim();
		if (head) return head;
	}
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
	/\s*[（[(]\s*feat(?:uring)?\.?\s*([^）\])]+)[）\])]\s*$/iu;
const FEAT_TAIL = /(?<!\p{L})feat(?:uring)?\.?\s*(.+)$/iu;

/**
 * Splits a "feat. A, B & C" / "(feat. A, B & C)" tail off the title.
 */
export function splitFeaturedTitle(title: string): {
	main: string;
	feats: string[];
} {
	for (const pattern of [FEAT_BRACKETED, FEAT_TAIL]) {
		const match = title.match(pattern);
		if (!match) continue;
		const feats = splitArtistList(match[1]);
		if (feats.length > 0) {
			return { main: title.slice(0, match.index).trim(), feats };
		}
	}
	return { main: title, feats: [] };
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

/** Splits a cover-credit artist list on slashes, commas and ampersands. */
function splitCoverArtists(raw: string): string[] {
	return raw
		.split(/\s*[，,、]\s*|\s*[/／]\s*|\s*＆\s*|\s+&\s+|\s*[×✕]\s*/u)
		.map((name) => name.trim())
		.filter((name) => name !== "" && name.length <= 60);
}

/** Patterns whose capture is the performer list of a cover credit. */
const COVER_CREDIT_PATTERNS: RegExp[] = [
	// "(covered by X)" / "【cover by X】"
	/[(（【[]\s*cover(?:ed)?\s+by\s+([^)）】\]]{1,80}?)\s*[)）】\]]/iu,
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
 * Pulls the performer names out of a cover credit — "covered by A & B",
 * "(cover by A)", "… /Cover A/B", "…【A×B】" — so the artist row can list
 * them. Requiring two names in a trailing bracket keeps single channel/group
 * tags ("【FUWAMOCO】") out.
 */
function extractCoverArtists(title: string, artist?: string): string[] {
	for (const pattern of COVER_CREDIT_PATTERNS) {
		const match = title.match(pattern);
		if (!match) continue;
		const artists = splitCoverArtists(match[1]);
		if (artists.length > 0) return artists;
	}
	const list = title.match(TRAILING_TAG_LIST);
	if (list) {
		const artists = splitCoverArtists(list[1]);
		if (artists.length >= 2) return artists;
	}
	// "Artist - Song (cover)" is a prefix credit, not a performer list.
	const primary = artist?.trim();
	if (!primary || !title.toLowerCase().startsWith(primary.toLowerCase())) {
		const dash = title.match(DASH_COVER_CREDIT);
		if (dash) {
			const artists = splitCoverArtists(dash[1]);
			if (artists.length > 0) return artists;
		}
	}
	return [];
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
	if (clean) {
		coverArtists = extractCoverArtists(title, artist);
		const extracted = extractCredits(title);
		credits = extracted.credits;
		title = extracted.title;
		title = cleanUpTitle(title);
		title = stripArtistPrefix(title, artist, credits);
		title = stripArtistSuffix(title, artist);
	}
	const { main, feats } = splitFeaturedTitle(title);
	return { main: applyMode(main, mode), feats, credits, coverArtists };
}

/** Single-string variant (e.g. Discord presence); feat tail stays inline. */
export function displayTitle(
	title: string,
	mode: TitleMode,
	clean = false,
	artist?: string,
): string {
	const { main, feats } = formatTitleParts(title, mode, clean, artist);
	return feats.length > 0 ? `${main} (feat. ${joinArtists(feats)})` : main;
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
 * Strips leading artist credits from the title. Two conventions:
 * "<artist> - Song" (e.g. "Chenomio -フィクションです。feat.重音テト") and
 * comma/ampersand chains — "Dutch Disorder, Cryogenic, & Unlocked, Heroine".
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
	if (!title.toLowerCase().startsWith(primary.toLowerCase())) return title;

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

	let out = title;
	// "<artist> - Song" convention.
	out = out
		.replace(new RegExp(`^${escapeRegExp(primary)}\\s*[-–—]\\s*`, "i"), "")
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
	// "Night Dancer (cover)" → "Night Dancer"
	new RegExp(
		String.raw`\s*` +
			BRACKET_OPEN +
			String.raw`\s*cover(?:ed)?\s*` +
			BRACKET_CLOSE +
			String.raw`\s*$`,
		"i",
	),
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
 */
export function cleanUpTitle(title: string): string {
	const coverContext = COVER_CONTEXT.test(title);
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
		if (out === before) break;
	}
	return out.trim() === "" ? title : out.trim();
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

/** Full-width decorative bracket pairs used as emphasis/tags. */
const DECOR_OPEN = "【『「《〈≪";
const DECOR_CLOSE = "】』」》〉≫";

const HASHTAG_TAIL = /(?:\s*#\S+)+\s*$/u;
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
const SEPARATOR_TAIL = /\s*[-–—/|｜·・／]\s*$/;

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

/** Settings-bound title formatter for plain-string display sites. */
export function useDisplayTitle(): (title: string) => string {
	const [settings] = useSettings();
	return useCallback(
		(title: string) =>
			displayTitle(title, settings.titleMode, settings.cleanTitles),
		[settings.cleanTitles, settings.titleMode],
	);
}

/** Settings-bound variant that keeps feats and credits separate. */
export function useFormatTitle(): (
	title: string,
	artist?: string,
) => {
	main: string;
	feats: string[];
	credits: TitleCredit[];
	coverArtists: string[];
} {
	const [settings] = useSettings();
	return useCallback(
		(title: string, artist?: string) =>
			formatTitleParts(title, settings.titleMode, settings.cleanTitles, artist),
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
		const author = content
			.replace(TAG_PATTERNS[tag], "")
			.replace(/\bby\b/i, "")
			.replace(/\bver(?:sion)?\.?/i, "")
			.trim()
			.replace(/^[\s\-–—:：·・]+|[\s\-–—:：·・]+$/g, "");
		if (!author || author.length > 40 || QUALIFIER_WORDS.test(author)) {
			return null;
		}
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
