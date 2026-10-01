/** Lyrics providers and their user-facing metadata. */
export type LyricsProviderId = "lrclib" | "musixmatch" | "youtube";

export interface LyricsProvider {
	id: LyricsProviderId;
	label: string;
	/** Shown as the source under the lyrics. */
	attribution: string;
}

export const LYRICS_PROVIDERS: readonly LyricsProvider[] = [
	{ id: "lrclib", label: "LRCLIB", attribution: "LRCLIB" },
	{ id: "musixmatch", label: "Musixmatch", attribution: "Musixmatch" },
	{ id: "youtube", label: "YouTube", attribution: "YouTube Music" },
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
