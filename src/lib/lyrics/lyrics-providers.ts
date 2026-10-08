/** Lyrics providers: metadata, ordering and display selection. */

import type { LrcLine } from "./lrclib";

export type LyricsProviderId =
	| "lrclib"
	| "musixmatch"
	| "youtube"
	| "vocadb"
	| "lrcred";

/**
 * How detailed a provider's lyrics are, simplest first. "word" is reserved
 * for word-by-word timing (karaoke-style) if a provider integration grows it.
 */
export type LyricsKind = "plain" | "synced" | "word";

export const LYRICS_KIND_LABELS: Record<LyricsKind, string> = {
	plain: "Plain",
	synced: "Synced",
	word: "Word sync",
};

export interface LyricsProvider {
	id: LyricsProviderId;
	label: string;
	/** Shown as the source under the lyrics. */
	attribution: string;
	/** Lyric detail levels this provider's integration can return. */
	kinds: readonly LyricsKind[];
}

export const LYRICS_PROVIDERS: readonly LyricsProvider[] = [
	{
		id: "lrclib",
		label: "LRCLIB",
		attribution: "LRCLIB",
		kinds: ["synced", "plain"],
	},
	{
		id: "musixmatch",
		label: "Musixmatch",
		attribution: "Musixmatch",
		kinds: ["word", "synced"],
	},
	{
		id: "youtube",
		label: "YouTube",
		attribution: "YouTube Music",
		kinds: ["synced", "plain"],
	},
	{ id: "vocadb", label: "VocaDB", attribution: "VocaDB", kinds: ["plain"] },
	{
		id: "lrcred",
		label: "lrc.red",
		attribution: "lrc.red",
		kinds: ["word", "synced", "plain"],
	},
];

export const DEFAULT_LYRICS_PROVIDER_ORDER: LyricsProviderId[] =
	LYRICS_PROVIDERS.map((provider) => provider.id);

const VALID_IDS = new Set<LyricsProviderId>(DEFAULT_LYRICS_PROVIDER_ORDER);

/**
 * Coerces stored/unknown data into a valid provider order: keeps known ids in
 * their stored order, drops duplicates, then appends any missing providers.
 */
export function normalizeProviderOrder(value: unknown): LyricsProviderId[] {
	const order: LyricsProviderId[] = [];
	if (Array.isArray(value)) {
		for (const id of value) {
			if (typeof id === "string" && VALID_IDS.has(id as LyricsProviderId)) {
				const providerId = id as LyricsProviderId;
				if (!order.includes(providerId)) order.push(providerId);
			}
		}
	}
	for (const id of DEFAULT_LYRICS_PROVIDER_ORDER) {
		if (!order.includes(id)) order.push(id);
	}
	return order;
}

/** Timing level of the lyrics a provider payload actually carries. */
export function lyricsKind(lyrics: { synced: LrcLine[] | null }): LyricsKind {
	if (!lyrics.synced) return "plain";
	return lyrics.synced.some((line) => line.words && line.words.length > 0)
		? "word"
		: "synced";
}

/** What the display picker needs to know about a provider's lyrics. */
export interface SelectableLyrics {
	synced: LrcLine[] | null;
	/** Matched on artist + title (or authoritative), not a loose match. */
	confirmed: boolean;
}

/**
 * Picks the provider to display among those whose lyrics have arrived. A
 * confirmed match beats a loose one even when the loose provider has higher
 * priority, and word-synced lyrics beat line-synced ones; ties keep the
 * priority order. Plain lyrics only compete on priority, unless
 * `preferSynced` promotes the best timed source over them. Returns null when
 * no provider has lyrics yet.
 */
export function pickProvider<T extends string>(
	order: readonly T[],
	sources: Readonly<Record<T, SelectableLyrics | null | undefined>>,
	preferSynced: boolean,
): T | null {
	const available = order.filter((id) => sources[id]);
	if (available.length === 0) return null;
	const find = (test: (lyrics: SelectableLyrics) => boolean) =>
		available.find((id) => {
			const lyrics = sources[id];
			return lyrics != null && test(lyrics);
		});
	const confirmedWord = find(
		(lyrics) => lyrics.confirmed && lyricsKind(lyrics) === "word",
	);
	const confirmedSynced = find(
		(lyrics) => lyrics.confirmed && lyrics.synced !== null,
	);
	const word = find((lyrics) => lyricsKind(lyrics) === "word");
	const synced = find((lyrics) => lyrics.synced !== null);
	const promoted = preferSynced
		? (confirmedWord ?? confirmedSynced ?? word ?? synced)
		: (confirmedWord ?? confirmedSynced);
	return promoted ?? available[0];
}
