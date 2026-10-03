import { invoke, isTauri } from "@tauri-apps/api/core";
import { platform } from "@tauri-apps/plugin-os";

window.electron = {
	login: () => invoke<string | null>("login"),
	getCookie: () => invoke<string | null>("get_cookie"),
	logout: () => invoke<boolean>("logout"),
};

/** The running OS, or null outside a Tauri window (plain browser dev). */
const OS = isTauri() ? platform() : null;

export const PROXY_ORIGIN =
	OS === "windows" || OS === "android"
		? "http://proxy.localhost"
		: "proxy://localhost";

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
