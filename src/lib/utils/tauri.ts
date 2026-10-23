import { invoke, isTauri } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";
import packageJson from "../../../package.json";
import { hiResThumb } from "./utils";

// The shim exists only in the app window; tests and plain-browser tooling
// import this module without one.
if (typeof window !== "undefined") {
	window.electron = {
		login: () => invoke<string | null>("login"),
		getCookie: () => invoke<string | null>("get_cookie"),
		logout: () => invoke<boolean>("logout"),
	};
}

/** The running OS, or null outside a Tauri window (plain browser dev). */
const OS = isTauri() ? platform() : null;

export const PROXY_ORIGIN =
	OS === "windows" || OS === "android"
		? "http://proxy.localhost"
		: "proxy://localhost";

/** App identity for third-party APIs that ask for a descriptive User-Agent. */
export const USER_AGENT = `YuMusic v${packageJson.version} (https://git.yumeo.dev/Yumeo/YuMusic)`;

/**
 * Routes a request through the app's Tauri proxy. The proxy forwards the given
 * headers upstream from Rust — the only way to send headers the WebView
 * forbids from scripts, notably `User-Agent`. The request method and abort
 * signal pass through too, so bodyless POSTs work (request bodies are not
 * supported). Outside Tauri the request goes out directly (browser dev, where
 * such headers cannot be set at all).
 */
export function proxiedFetch(
	url: string,
	headers: Record<string, string> = {},
	init: Pick<RequestInit, "method" | "signal"> = {},
): Promise<Response> {
	const target = new URL(url);
	if (!isTauri()) return fetch(url, { ...init, headers });
	const proxied = new URL(`${PROXY_ORIGIN}${target.pathname}${target.search}`);
	proxied.searchParams.set("__host", target.host);
	return fetch(proxied, {
		...init,
		headers: { "X-Proxy-Headers": JSON.stringify(headers) },
	});
}

/**
 * Mobile targets (Android/iOS) keep the system window chrome and have no
 * draggable desktop window, so the custom titlebar and its window controls
 * are omitted there.
 */
export const IS_MOBILE = OS === "android" || OS === "ios";

/**
 * Android WebView's `shouldInterceptRequest` does not expose request bodies
 * to custom protocol handlers, so wry always delivers an empty body to the
 * proxy on Android. The frontend compensates by base64-encoding the body
 * into the X-Proxy-Body header, which the proxy decodes server-side.
 */
export const NEEDS_BODY_HEADER = OS === "android";

/**
 * Rewrites a remote image URL to load through the app's Tauri proxy. The
 * proxy keeps an in-memory image cache (custom-scheme responses bypass the
 * WebView's HTTP cache), paces concurrent upstream fetches and backs off on
 * 429 — so every artwork goes upstream at most once per app run instead of
 * once per <img> mount, which is what gets images rate-limited. Data,
 * blob, relative and already-proxied URLs pass through unchanged.
 */
export function proxiedImageUrl(
	url: string | undefined | null,
	size = 384,
): string {
	if (!url || url.startsWith(PROXY_ORIGIN) || url.startsWith("proxy://")) {
		return url ?? "";
	}
	if (
		url.startsWith("data:") ||
		url.startsWith("blob:") ||
		url.startsWith("/")
	) {
		return url;
	}
	try {
		const parsed = new URL(hiResThumb(url, size));
		// Keep the frame's aspect ratio so the existing square crop stays valid.
		if (size <= 192 && parsed.hostname === "i.ytimg.com") {
			parsed.pathname = parsed.pathname
				.replace(/\/(?:maxresdefault|hq720)\./, "/mqdefault.")
				.replace(/\/sddefault\./, "/hqdefault.");
		}
		const proxied = new URL(
			`${PROXY_ORIGIN}${parsed.pathname}${parsed.search}`,
		);
		proxied.searchParams.set("__host", parsed.host);
		return proxied.toString();
	} catch {
		return url;
	}
}
