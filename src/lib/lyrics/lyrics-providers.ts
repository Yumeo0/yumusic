import { LruCache } from "../utils/lru-cache";
import { getTrackQueueMeta } from "../youtube/track-meta";
import {
	type LyricsKind,
	lyricsKind,
	type ProviderLyrics,
	type SelectableLyrics,
} from "./lyrics";

export const LYRICS_KIND_LABELS: Record<LyricsKind, string> = {
	plain: "Plain",
	synced: "Synced",
	word: "Word sync",
};

interface LyricsQuery {
	songId: string;
	title: string;
	artist: string;
	duration: number;
	looseMatch: boolean;
}

interface ProviderDefinition {
	label: string;
	attribution: string;
	kinds: readonly LyricsKind[];
	load: (query: LyricsQuery) => Promise<ProviderLyrics | null>;
}

const providers = {
	youtube: {
		label: "YouTube",
		attribution: "YouTube Music",
		kinds: ["synced", "plain"],
		async load({ songId }) {
			const { getSongLyrics } = await import("./youtube");
			return getSongLyrics(songId);
		},
	},
	lrclib: {
		label: "LRCLIB",
		attribution: "LRCLIB",
		kinds: ["synced", "plain"],
		async load({ title, artist, duration, looseMatch }) {
			const { fetchSyncedLyrics } = await import("./lrclib");
			const result = await fetchSyncedLyrics(
				title,
				artist,
				duration,
				looseMatch,
			);
			return result && (result.synced || result.plain) ? result : null;
		},
	},
	musixmatch: {
		label: "Musixmatch",
		attribution: "Musixmatch",
		kinds: ["word", "synced"],
		async load({ title, artist, duration }) {
			const { fetchMusixmatchSynced } = await import("./musixmatch");
			const synced = await fetchMusixmatchSynced(title, artist, duration);
			return synced?.length ? { synced, plain: null, confirmed: true } : null;
		},
	},
	lrcred: {
		label: "lrc.red",
		attribution: "lrc.red",
		kinds: ["word", "synced", "plain"],
		async load({ title, artist, duration }) {
			const { fetchLrcRedLyrics } = await import("./lrcred");
			return fetchLrcRedLyrics(title, artist, duration);
		},
	},
	genius: {
		label: "Genius",
		attribution: "Genius",
		kinds: ["plain"],
		async load({ songId, title, artist }) {
			const [{ fetchGeniusLyrics }, meta] = await Promise.all([
				import("./genius"),
				getTrackQueueMeta(songId),
			]);
			return fetchGeniusLyrics(title, artist, meta?.album?.name);
		},
	},
	vocadb: {
		label: "VocaDB",
		attribution: "VocaDB",
		kinds: ["plain"],
		async load({ title, artist, duration }) {
			const { fetchVocadbLyrics } = await import("./vocadb");
			const plain = await fetchVocadbLyrics(title, artist, duration);
			return plain ? { synced: null, plain, confirmed: true } : null;
		},
	},
} satisfies Record<string, ProviderDefinition>;

export type LyricsProviderId = keyof typeof providers;
export type LyricsProvider = Omit<ProviderDefinition, "load"> & {
	id: LyricsProviderId;
};
export type LyricsSources = Partial<
	Record<LyricsProviderId, ProviderLyrics | null>
>;
export const DEFAULT_LYRICS_PROVIDER_ORDER = Object.keys(
	providers,
) as LyricsProviderId[];

const LYRICS_RETRY_MS = 5 * 60_000;
const recentLyrics = new LruCache<
	string,
	{
		retryAt: number;
		requests: {
			id: LyricsProviderId;
			result: Promise<ProviderLyrics | null>;
		}[];
	}
>(16);

export function lyricsQueryKey(query: LyricsQuery): string {
	return JSON.stringify([
		query.songId,
		query.title,
		query.artist,
		query.duration,
		query.looseMatch,
	]);
}

export function lyricsProvider(id: LyricsProviderId): LyricsProvider {
	const { label, attribution, kinds } = providers[id];
	return { id, label, attribution, kinds };
}

export function loadLyricsSources(
	query: LyricsQuery,
	deliver: (id: LyricsProviderId, lyrics: ProviderLyrics | null) => void,
) {
	const key = lyricsQueryKey(query);
	const now = Date.now();
	let cached = recentLyrics.get(key);
	if (!cached || cached.retryAt <= now) {
		cached = {
			retryAt: now + LYRICS_RETRY_MS,
			requests: DEFAULT_LYRICS_PROVIDER_ORDER.map((id) => ({
				id,
				result: providers[id].load(query).catch(() => null),
			})),
		};
		recentLyrics.set(key, cached);
	}
	let active = true;
	for (const { id, result } of cached.requests) {
		void result.then((lyrics) => {
			if (active) deliver(id, lyrics);
		});
	}
	return () => {
		active = false;
	};
}

/**
 * Coerces stored/unknown data into a valid provider order: keeps known ids in
 * their stored order, drops duplicates, then appends any missing providers.
 */
export function normalizeProviderOrder(value: unknown): LyricsProviderId[] {
	const order: LyricsProviderId[] = [];
	if (Array.isArray(value)) {
		for (const id of value) {
			if (typeof id === "string" && Object.hasOwn(providers, id)) {
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
	sources: Readonly<Partial<Record<T, SelectableLyrics | null>>>,
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
