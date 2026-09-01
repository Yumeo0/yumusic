import { useEffect, useRef, useState } from "react";
import { useSettings } from "./settings";
import { getYoutubeClient } from "./youtube-client";

/**
 * Resolves artists' original-language names (YouTube localizes them per
 * session locale — e.g. ずっと真夜中でいいのに。/ ZUTOMAYO). The app session
 * runs in English, so the original name is fetched with a temporary hl=ja
 * switch and cached per channel id.
 */

const STORAGE_KEY = "yumusic:artist-names";
const MAX_ENTRIES = 300;
/** Music-side requests are serialized with spacing to stay polite. */
const FETCH_SPACING_MS = 350;

const cache = new Map<string, string>();
const failed = new Set<string>();
const inflight = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();
let hydrated = false;

function hydrate() {
	if (hydrated) return;
	hydrated = true;
	try {
		const stored = JSON.parse(
			localStorage.getItem(STORAGE_KEY) ?? "{}",
		) as Record<string, string>;
		for (const [id, name] of Object.entries(stored)) {
			cache.set(id, name);
		}
	} catch {
		// corrupted store — start fresh
	}
}

function persist() {
	try {
		const entries = [...cache.entries()].slice(-MAX_ENTRIES);
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify(Object.fromEntries(entries)),
		);
	} catch {
		// storage unavailable — memory cache still applies
	}
}

function notify() {
	for (const listener of listeners) listener();
}

let queue: Promise<unknown> = Promise.resolve();

function queueFetch<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.then(
		() => new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS)),
		() => new Promise((resolve) => setTimeout(resolve, FETCH_SPACING_MS)),
	);
	return run;
}

/** Fetches the artist page under hl=ja and reads the localized name. */
async function fetchOriginalName(channelId: string): Promise<string | null> {
	const client = await getYoutubeClient();
	const clientContext = client.session.context.client as { hl?: string };
	const previousHl = clientContext.hl;
	try {
		clientContext.hl = "ja";
		const artist = await client.music.getArtist(channelId);
		const title = artist.header?.title?.toString().trim();
		return title || null;
	} catch (error) {
		console.warn("[artist-names] failed to resolve", channelId, error);
		return null;
	} finally {
		clientContext.hl = previousHl;
	}
}

export function resolveOriginalArtist(
	channelId: string,
): Promise<string | null> {
	hydrate();
	if (cache.has(channelId))
		return Promise.resolve(cache.get(channelId) ?? null);
	if (failed.has(channelId)) return Promise.resolve(null);
	let request = inflight.get(channelId);
	if (!request) {
		request = queueFetch(() => fetchOriginalName(channelId))
			.then((name) => {
				if (name) {
					cache.set(channelId, name);
					persist();
					notify();
				} else {
					failed.add(channelId);
				}
				return name;
			})
			.finally(() => {
				inflight.delete(channelId);
			});
		inflight.set(channelId, request);
	}
	return request;
}

/**
 * Artist name display: with originalArtists enabled, artists with a channel
 * id resolve to their original-language name (fetched once, then cached);
 * otherwise the session-localized name is shown unchanged.
 */
export function useArtistName(
	name: string | undefined,
	channelId?: string,
): string {
	const [settings] = useSettings();
	const original = settings.originalArtists;
	const fallback = name ?? "";
	const [resolved, setResolved] = useState<string | undefined>(() => {
		hydrate();
		return channelId ? cache.get(channelId) : undefined;
	});

	useEffect(() => {
		hydrate();
		if (channelId) setResolved(cache.get(channelId));
	}, [channelId]);

	useEffect(() => {
		if (!original || !channelId) return;
		let cancelled = false;
		resolveOriginalArtist(channelId).then((name) => {
			if (!cancelled && name) setResolved(name);
		});
		return () => {
			cancelled = true;
		};
	}, [original, channelId]);

	const listenerRef = useRef(notify);
	listenerRef.current = notify;
	useEffect(() => {
		if (!original) return;
		const listener = () => {
			if (channelId && cache.has(channelId)) {
				setResolved(cache.get(channelId));
			}
		};
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, [original, channelId]);

	return original && channelId ? (resolved ?? fallback) : fallback;
}
