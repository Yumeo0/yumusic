import { bytesToBase64 } from "../utils/base64";
import { buildProxyUrl, NEEDS_BODY_HEADER } from "../utils/tauri";
import { botguardService } from "./botguard-service";

/** Base64-encodes a request body for transport inside an HTTP header. */
async function bodyToBase64(body: BodyInit): Promise<string | null> {
	let bytes: Uint8Array;
	if (typeof body === "string") {
		bytes = new TextEncoder().encode(body);
	} else if (body instanceof Blob) {
		bytes = new Uint8Array(await body.arrayBuffer());
	} else if (body instanceof ArrayBuffer) {
		bytes = new Uint8Array(body);
	} else if (ArrayBuffer.isView(body)) {
		bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	} else {
		return null;
	}
	return bytesToBase64(bytes);
}

export async function youtubeFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const urlStr =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	const url = new URL(urlStr);

	const proxyUrl = buildProxyUrl(url);

	const headersObj: Record<string, string> = {};

	const addHeaders = (headers?: HeadersInit) => {
		if (!headers) return;
		new Headers(headers).forEach((value, key) => {
			headersObj[key] = value;
		});
	};
	if (input instanceof Request) addHeaders(input.headers);
	addHeaders(init?.headers);

	// Match the browser session that minted the token, including Android's
	// dedicated desktop YouTube view rather than the music view's mobile UA.
	const isYoutube =
		url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com");
	if (
		(isYoutube || url.hostname.endsWith(".googlevideo.com")) &&
		botguardService.playbackUserAgent &&
		!headersObj["User-Agent"] &&
		!headersObj["user-agent"]
	) {
		headersObj["User-Agent"] = botguardService.playbackUserAgent;
	}
	const cookie = isYoutube
		? (await window.electron.getCookie()) || botguardService.playbackCookie
		: undefined;
	if (cookie && !headersObj.cookie && !headersObj.Cookie) {
		headersObj.Cookie = cookie;
	}

	let body: BodyInit | null = null;
	const method =
		init?.method || (input instanceof Request ? input.method : "GET");

	if (method !== "GET" && method !== "HEAD") {
		if (init?.body) {
			body = init.body;
		} else if (input instanceof Request && input.body) {
			try {
				body = await input.blob();
			} catch (error) {
				console.error("[youtubeFetch] Failed to read body:", error);
			}
		}
	}

	// Propagate SABR cancellation so skipped tracks stop retaining response buffers.
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		console.error("[youtubeFetch] Request timed out after 30 seconds");
		controller.abort();
	}, 30000);
	try {
		const proxyHeaders: Record<string, string> = {
			"X-Proxy-Headers": JSON.stringify(headersObj),
		};
		if (NEEDS_BODY_HEADER && body != null) {
			const encoded = await bodyToBase64(body);
			if (encoded) proxyHeaders["X-Proxy-Body"] = encoded;
		}

		const response = await fetch(proxyUrl.toString(), {
			method: method,
			headers: proxyHeaders,
			body: body,
			signal: AbortSignal.any([
				controller.signal,
				...(init?.signal
					? [init.signal]
					: input instanceof Request
						? [input.signal]
						: []),
			]),
		});

		if (!response.ok) {
			response
				.clone()
				.text()
				.then((body) =>
					console.error("[youtubeFetch] Error body:", body.slice(0, 600)),
				)
				.catch(() => undefined);
		}
		return response;
	} catch (error) {
		console.error("[youtubeFetch] Fetch failed:", error);
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

// Bun's `fetch` type carries a `preconnect` member; provide a no-op so
// the custom fetch is assignable to youtubei.js' `typeof fetch` option.
Object.assign(youtubeFetch, { preconnect: () => undefined });
