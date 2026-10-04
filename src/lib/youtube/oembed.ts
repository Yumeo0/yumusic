/**
 * Fetches the original (uploader-set) title and artist from YouTube's public
 * oEmbed endpoint, which — unlike the InnerTube responses — is not affected by
 * the session locale. Results are cached per video id, and failures are retried
 * after a short cooldown so a flaky network doesn't keep re-requesting.
 *
 * oEmbed sends no CORS headers, so requests must go through the app's Tauri
 * proxy; the caller passes its `fetch` implementation in.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OembedMetadata {
	title: string | null;
	author: string | null;
}

const CONNECTION_TIMEOUT_MS = 8000;
/** Failed fetches are retried once this cooldown elapses. */
const FAILED_RETRY_MS = 30_000;
const MAX_ENTRIES = 500;

const cache = new Map<string, Promise<OembedMetadata | null>>();
const retryAt = new Map<string, number>();

/** Uploader channels are named "<Artist> - Topic"; drop that suffix. */
function cleanAuthor(name: string | undefined): string | null {
	const cleaned = name?.replace(/\s*-\s*Topic$/i, "").trim();
	return cleaned ? cleaned : null;
}

async function fetchMetadata(
	videoId: string,
	fetchFn: FetchLike,
): Promise<OembedMetadata | null> {
	try {
		const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
			`https://www.youtube.com/watch?v=${videoId}`,
		)}`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetchFn(url, {
				headers: { Accept: "application/json" },
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
		if (!response.ok) {
			retryAt.set(videoId, Date.now() + FAILED_RETRY_MS);
			return null;
		}
		const data = (await response.json()) as {
			title?: string;
			author_name?: string;
		};
		const title = data.title?.trim() || null;
		const author = cleanAuthor(data.author_name);
		if (!title && !author) {
			retryAt.set(videoId, Date.now() + FAILED_RETRY_MS);
			return null;
		}
		return { title, author };
	} catch (error) {
		console.warn("[oembed] could not fetch metadata for", videoId, error);
		retryAt.set(videoId, Date.now() + FAILED_RETRY_MS);
		return null;
	}
}

/**
 * Original title and artist for a video id, `null` when unavailable. Cached;
 * failed fetches return `null` immediately until their cooldown passes.
 */
export function getOembedMetadata(
	videoId: string,
	fetchFn: FetchLike,
): Promise<OembedMetadata | null> {
	const existing = cache.get(videoId);
	const retry = retryAt.get(videoId);
	if (existing && (retry === undefined || Date.now() < retry)) {
		return existing;
	}

	const promise = fetchMetadata(videoId, fetchFn);
	cache.set(videoId, promise);
	while (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	return promise;
}
