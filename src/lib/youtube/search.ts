import { getYoutubeClient } from "./client-session";

/** Ids one bulk queue request takes; more than a search list holds anyway. */
const MAX_QUEUE_IDS = 50;

/** Pulls `videoId → length label` pairs out of a bulk queue response. */
function collectQueueLengths(node: unknown, out: Map<string, string>): void {
	if (Array.isArray(node)) {
		for (const item of node) collectQueueLengths(item, out);
		return;
	}
	if (!node || typeof node !== "object") return;
	const record = node as Record<string, unknown>;
	const panel = record.playlistPanelVideoRenderer as
		| { videoId?: string; lengthText?: { runs?: { text?: string }[] } }
		| undefined;
	const id = panel?.videoId;
	const text = panel?.lengthText?.runs?.[0]?.text;
	if (id && text) out.set(id, text);
	for (const value of Object.values(record)) collectQueueLengths(value, out);
}

/**
 * Length labels for a batch of tracks, from the bulk queue endpoint. The mixed
 * "All" search rows carry no length (their trailing column shows play counts
 * instead), so one call backfills every listed track at once.
 */
export async function getTrackDurations(
	videoIds: string[],
	signal?: AbortSignal,
): Promise<Map<string, string>> {
	const durations = new Map<string, string>();
	if (videoIds.length === 0) return durations;
	const client = await getYoutubeClient();
	signal?.throwIfAborted();
	// Actions.execute accepts a JSON payload. Use the session's HTTP client so
	// a tab or query change can cancel the request itself.
	const response = await client.session.http.fetch("/music/get_queue", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoIds: videoIds.slice(0, MAX_QUEUE_IDS),
			client: "YTMUSIC",
			isAudioOnly: true,
		}),
		signal,
	});
	const data: unknown = await response.json();
	signal?.throwIfAborted();
	collectQueueLengths(data, durations);
	return durations;
}

/**
 * Search-bar completions YouTube Music suggests for a partial query. Returns
 * the query strings only, de-duplicated; failures resolve to an empty list so
 * typing never breaks when suggestions are unavailable.
 */
export async function getSearchCompletions(query: string): Promise<string[]> {
	const trimmed = query.trim();
	if (!trimmed) return [];
	try {
		const client = await getYoutubeClient();
		const sections = await client.music.getSearchSuggestions(trimmed);
		const seen = new Set<string>();
		const suggestions: string[] = [];
		for (const section of sections) {
			for (const node of section.contents ?? []) {
				const text = (
					node as unknown as { suggestion?: { toString(): string } }
				).suggestion
					?.toString()
					.trim();
				if (!text) continue;
				const key = text.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				suggestions.push(text);
			}
		}
		return suggestions;
	} catch (error) {
		console.warn("[search] failed to load completions:", error);
		return [];
	}
}
