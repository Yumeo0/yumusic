import { invoke } from "@tauri-apps/api/core";

window.electron = {
	login: () => invoke<string | null>("login"),
	getCookie: () => invoke<string | null>("get_cookie"),
	logout: () => invoke<boolean>("logout"),
};

function proxyOrigin(): string {
	const userAgent = navigator.userAgent;
	if (userAgent.includes("Windows") || userAgent.includes("Android")) {
		return "http://proxy.localhost";
	}
	return "proxy://localhost";
}

export const PROXY_ORIGIN = proxyOrigin();

/**
 * Android WebView's `shouldInterceptRequest` does not expose request bodies
 * to custom protocol handlers, so wry always delivers an empty body to the
 * proxy on Android. The frontend compensates by base64-encoding the body
 * into the X-Proxy-Body header, which the proxy decodes server-side.
 */
export const NEEDS_BODY_HEADER = navigator.userAgent.includes("Android");

/**
 * Rewrites a remote image URL to load through the app's Tauri proxy. The
 * proxy keeps an in-memory image cache (custom-scheme responses bypass the
 * WebView's HTTP cache), paces concurrent upstream fetches and backs off on
 * 429 — so every artwork goes upstream at most once per app run instead of
 * once per <img> mount, which is what gets images rate-limited. Data,
 * blob, relative and already-proxied URLs pass through unchanged.
 */
export function proxiedImageUrl(url: string | undefined | null): string {
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
		const parsed = new URL(url);
		const proxied = new URL(
			`${PROXY_ORIGIN}${parsed.pathname}${parsed.search}`,
		);
		proxied.searchParams.set("__host", parsed.host);
		return proxied.toString();
	} catch {
		return url;
	}
}
