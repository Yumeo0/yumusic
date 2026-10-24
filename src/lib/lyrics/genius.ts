import type { DefaultTreeAdapterMap } from "parse5";
import { proxiedFetch, USER_AGENT } from "../utils/tauri";
import { cleanSearchTitle, formatTitleParts } from "../utils/title";

const BASE = "https://genius.com";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CANDIDATES = 3;

interface GeniusSong {
	id?: number;
	title?: string;
	url?: string;
	path?: string;
	hidden?: boolean;
	instrumental?: boolean;
	lyrics_state?: string;
	primary_artist_names?: string;
	primary_artist?: { name?: string };
	primary_artists?: Array<{ name?: string }>;
}

interface GeniusSearch {
	response?: {
		sections?: Array<{
			type?: string;
			hits?: Array<{ type?: string; result?: GeniusSong }>;
		}>;
	};
}

export interface GeniusLyrics {
	synced: null;
	plain: string;
	confirmed: boolean;
}

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];

function attribute(node: HtmlElement, name: string): string | undefined {
	return node.attrs.find((attr) => attr.name === name)?.value;
}

/** Extract text without running page scripts or rendering remote markup. */
function lyricsText(node: HtmlNode): string {
	if ("value" in node) return node.value;
	if (!("childNodes" in node)) return "";
	if ("tagName" in node) {
		if (
			["script", "style", "button", "svg", "iframe", "template"].includes(
				node.tagName,
			) ||
			attribute(node, "data-exclude-from-selection") === "true" ||
			attribute(node, "aria-hidden") === "true"
		)
			return "";
		if (node.tagName === "br") return "\n";
	}
	const text = node.childNodes.map(lyricsText).join("");
	return "tagName" in node && ["div", "p", "li"].includes(node.tagName)
		? `\n${text}\n`
		: text;
}

/** Genius splits lyrics around ads; collect only its marked lyrics sections. */
export async function parseGeniusLyrics(html: string): Promise<string | null> {
	// Load the HTML parser only after a matching song page has been fetched.
	const { parse } = await import("parse5");
	const containers: HtmlElement[] = [];
	const legacy: HtmlElement[] = [];
	const visit = (node: HtmlNode) => {
		if ("tagName" in node) {
			if (attribute(node, "data-lyrics-container") === "true") {
				containers.push(node);
				return;
			}
			if (attribute(node, "class")?.split(/\s+/).includes("lyrics")) {
				legacy.push(node);
				return;
			}
		}
		if ("childNodes" in node) node.childNodes.forEach(visit);
	};
	visit(parse(html));
	const text = (containers.length ? containers : legacy)
		.map(lyricsText)
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n")
		.replace(/\r\n?/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/[\t ]+\n/g, "\n")
		.replace(/\n[\t ]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text || null;
}

function fold(value: string): string {
	return value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, "");
}

function artistMatches(song: GeniusSong, artist: string): boolean {
	const names = [
		song.primary_artist_names,
		song.primary_artist?.name,
		...(song.primary_artists ?? []).map((entry) => entry.name),
	];
	const variants = (name: string) =>
		[
			fold(name.replace(/\s*-\s*Topic$/i, "")),
			...name
				.split(/[,;&]|\s+(?:feat\.?|ft\.?|and)\s+/i)
				.flatMap((part) => [fold(part), fold(part.replace(/\([^)]*\)/g, ""))]),
		].filter(Boolean);
	const wanted = variants(artist);
	return names.some(
		(name) => name && variants(name).some((value) => wanted.includes(value)),
	);
}

/** Only follow song pages on Genius, never arbitrary URLs from a search hit. */
function songUrl(song: GeniusSong): string | null {
	try {
		const url = new URL(song.url ?? song.path ?? "", BASE);
		return url.origin === BASE && url.pathname.endsWith("-lyrics")
			? url.href
			: null;
	} catch {
		return null;
	}
}

async function search(
	query: string,
	signal: AbortSignal,
): Promise<GeniusSong[]> {
	const params = new URLSearchParams({ per_page: "5", q: query });
	const response = await proxiedFetch(
		`${BASE}/api/search/multi?${params}`,
		{ Accept: "application/json", "User-Agent": USER_AGENT },
		{ signal },
	);
	if (!response.ok) return [];
	const data = (await response.json()) as GeniusSearch;
	return (data.response?.sections ?? []).flatMap((section) =>
		(section.hits ?? []).flatMap((hit) =>
			hit.type === "song" && hit.result ? [hit.result] : [],
		),
	);
}

/** Search by cleaned title and artist, then fetch the matched song's plain lyrics. */
export async function fetchGeniusLyrics(
	title: string,
	artist: string,
): Promise<GeniusLyrics | null> {
	const original = cleanSearchTitle(title, artist).trim();
	if (!original) return null;
	const translated = formatTitleParts(
		title,
		"translation",
		true,
		artist,
	).main.trim();
	const tracks = [...new Set([original, translated].filter(Boolean))];
	const name = artist.replace(/\s*-\s*Topic$/i, "").trim();
	const seen = new Set<string>();
	const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	try {
		for (const track of tracks) {
			const queries = name ? [`${track} ${name}`, track] : [track];
			for (const query of queries) {
				const candidates = (await search(query, signal))
					.filter(
						(song) =>
							!song.hidden &&
							!song.instrumental &&
							(!song.lyrics_state || song.lyrics_state === "complete") &&
							song.title &&
							fold(cleanSearchTitle(song.title)) === fold(track),
					)
					.sort(
						(a, b) =>
							Number(artistMatches(b, name)) - Number(artistMatches(a, name)),
					);
				for (const song of candidates.slice(0, MAX_CANDIDATES)) {
					const url = songUrl(song);
					if (!url || seen.has(url)) continue;
					seen.add(url);
					const response = await proxiedFetch(
						url,
						{ Accept: "text/html", "User-Agent": USER_AGENT },
						{ signal },
					);
					if (!response.ok) continue;
					const plain = await parseGeniusLyrics(await response.text());
					if (plain)
						return {
							synced: null,
							plain,
							confirmed: artistMatches(song, name),
						};
				}
			}
		}
	} catch (error) {
		console.warn("[genius] lyrics lookup failed:", error);
	}
	return null;
}
