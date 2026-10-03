import { useCallback } from "react";
import { type TitleMode, useSettings } from "./settings";

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
	for (const separator of [" - ", " / ", "／", "//"]) {
		const idx = title.lastIndexOf(separator);
		if (idx <= 0 || idx >= title.length - separator.length) continue;
		const left = title.slice(0, idx).trim();
		const right = title.slice(idx + separator.length).trim();
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

/**
 * Full title pipeline: credit extraction → noise cleanup → artist-prefix
 * strip → feat-tail extraction → dual-title mode. Returns the display main
 * title, featured artists (styled separately) and credit pills.
 */
export function formatTitleParts(
	title: string,
	mode: TitleMode,
	clean = false,
	artist?: string,
): { main: string; feats: string[]; credits: TitleCredit[] } {
	let credits: TitleCredit[] = [];
	if (clean) {
		const extracted = extractCredits(title);
		credits = extracted.credits;
		title = extracted.title;
		title = cleanUpTitle(title);
		title = stripArtistPrefix(title, artist, credits);
		title = stripArtistSuffix(title, artist);
	}
	const { main, feats } = splitFeaturedTitle(title);
	return { main: applyMode(main, mode), feats, credits };
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

const BRACKET_OPEN = String.raw`[(（【\[]`;
const BRACKET_CLOSE = String.raw`[)）】\]]`;
const COVER_MARKER =
	BRACKET_OPEN +
	String.raw`\s*(?:\w+\s+)?cover(?:ed)?(?:\s+(?:by\s+.{1,60}?|version|ver\.?))?` +
	BRACKET_CLOSE;

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
	// "flos (Remix ver.) / R Sound Design - むﾄ (cover)" → "flos (Remix ver.)"
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
 * Strips known noise from the end of a title; never empties it. The rules
 * are applied to a fixpoint so patterns revealed by an earlier peel (e.g.
 * "(Cover)" after a trailing 【channel】 bracket) are also removed.
 */
export function cleanUpTitle(title: string): string {
	let out = title;
	for (;;) {
		const before = out;
		for (const rule of TITLE_NOISE) {
			out =
				typeof rule === "object" && "replacement" in rule
					? out.replace(rule.pattern, rule.replacement)
					: out.replace(rule, "");
		}
		out = stripDecorations(out);
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
const SEPARATOR_TAIL = /\s*[-–—/|｜·・]\s*$/;

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
 * ("【MV】怪物…" → "怪物…") and trailing qualifier groups
 * ("Idols (EDM Mashup) (Official Video)" → "Idols",
 * "G4L - English Cover" → "G4L").
 */
function stripDecorations(title: string): string {
	// A sole bracket pair wraps the song title ("【チューリングラブ// Turing
	// Love】") rather than tagging it, so unwrap it instead of dropping it.
	const sole = title.match(SOLE_TAG_BRACKET);
	if (sole?.[1].trim() && !LEADING_TAG_KEYWORD.test(sole[1])) {
		title = sole[1].trim();
	}
	let out = title.replace(HASHTAG_TAIL, "");
	for (;;) {
		const next = out
			.replace(VIDEO_MARKER_TAIL, "")
			.replace(TAG_TAIL, "")
			.replace(LEADING_TAG_BRACKET, (match, _open, content: string) =>
				LEADING_TAG_KEYWORD.test(content) ? "" : match,
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
