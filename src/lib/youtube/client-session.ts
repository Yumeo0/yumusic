import {
	Innertube,
	Platform,
	type Types,
	UniversalCache,
} from "youtubei.js/web";
import { youtubeFetch } from "./youtube-fetch";

interface ClientCache {
	instance: Innertube | null;
	/** Cookie the cached client was built with (`null` = signed out). */
	cookie: string | null;
	/** In-flight creation, shared by callers asking for the same auth state. */
	pending: Promise<Innertube> | null;
	pendingCookie: string | null;
}

// The app always fetches in English (matching the UI). A single client suffices
// because `hl` lives on the shared session.
const clientCache: ClientCache = {
	instance: null,
	cookie: null,
	pending: null,
	pendingCookie: null,
};

Platform.shim.eval = async (
	data: Types.BuildScriptResult,
	env: Record<string, Types.VMPrimative>,
) => {
	const properties = [];

	if (env.n) {
		properties.push(`n: exportedVars.nFunction("${env.n}")`);
	}

	if (env.sig) {
		properties.push(`sig: exportedVars.sigFunction("${env.sig}")`);
	}

	const code = `${data.output}\nreturn { ${properties.join(", ")} }`;

	return new Function(code)();
};

/**
 * Returns the English Innertube client, creating it at
 * most once per auth state. Concurrent callers share the in-flight creation,
 * and a signed-out creation can never replace an already-authenticated client —
 * without these guarantees, data fetches that start before the login cookie is
 * available (the home feed mounts before the layout's login check) could
 * clobber the session and silently drop the account: wrong recommendations, an
 * empty library and a nameless "User" in the sidebar.
 */
export async function getYoutubeClient(
	cookie?: string,
	refresh = false,
): Promise<Innertube> {
	const desired = cookie || (await window.electron.getCookie()) || null;

	// Reuse the current client when it already matches; never downgrade an
	// authenticated client just because no cookie was available this call.
	if (
		!refresh &&
		clientCache.instance &&
		(desired === clientCache.cookie || !desired)
	) {
		return clientCache.instance;
	}

	// Share an in-flight creation for the same auth state.
	if (clientCache.pending && clientCache.pendingCookie === desired) {
		return clientCache.pending;
	}

	clientCache.pendingCookie = desired;
	let pending: Promise<Innertube>;
	pending = Innertube.create({
		cache: new UniversalCache(false),
		generate_session_locally: true,
		cookie: desired || undefined,
		lang: "en",
		// Bun's `fetch` type carries a required `preconnect` member that the
		// DOM-flavored custom fetch lacks; the runtime object satisfies it
		// through the proxy adapter.
		fetch: youtubeFetch as typeof fetch,
	})
		.then((client) => {
			// Only adopt this client if no newer auth state was requested while
			// this creation was in flight.
			if (clientCache.pending === pending) {
				clientCache.instance = client;
				clientCache.cookie = desired;
			}
			return client;
		})
		.finally(() => {
			if (clientCache.pending === pending) {
				clientCache.pending = null;
				clientCache.pendingCookie = null;
			}
		});
	clientCache.pending = pending;

	return pending;
}
