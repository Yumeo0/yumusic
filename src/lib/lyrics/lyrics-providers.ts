/** Lyrics providers and their user-facing metadata. */
export type LyricsProviderId = "lrclib" | "musixmatch" | "youtube" | "vocadb";

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
		kinds: ["synced"],
	},
	{
		id: "youtube",
		label: "YouTube",
		attribution: "YouTube Music",
		kinds: ["synced", "plain"],
	},
	{ id: "vocadb", label: "VocaDB", attribution: "VocaDB", kinds: ["plain"] },
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
