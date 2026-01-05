import {
	Innertube,
	Platform,
	type Types,
	UniversalCache,
	YTNodes,
} from "youtubei.js/web";

export type Playlist = Awaited<ReturnType<Innertube["music"]["getPlaylist"]>>;
export type Library = Awaited<ReturnType<Innertube["music"]["getLibrary"]>>;

let youtube: Innertube | null = null;

// Set up JavaScript evaluator for deciphering URLs
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

export async function getYoutubeClient(cookie?: string) {
	if (youtube && !cookie) return youtube;

	// If cookie is provided, we force recreation or if we don't have one yet
	if (cookie || !youtube) {
		// Try to get cookie from electron if not provided
		const userCookie = cookie || (await window.electron.getCookie());

		youtube = await Innertube.create({
			cache: new UniversalCache(false),
			generate_session_locally: true,
			cookie: userCookie || undefined,
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const urlStr =
					typeof input === "string"
						? input
						: input instanceof URL
							? input.toString()
							: input.url;
				const url = new URL(urlStr);

				const proxyUrl = new URL(
					`http://localhost:8080${url.pathname}${url.search}`,
				);
				proxyUrl.searchParams.set("__host", url.host);

				const headersObj: Record<string, string> = {};

				// Helper to extract headers from HeadersInit
				const extractHeaders = (headers?: HeadersInit) => {
					if (!headers) return;
					if (headers instanceof Headers) {
						headers.forEach((value, key) => {
							headersObj[key] = value;
						});
					} else if (Array.isArray(headers)) {
						headers.forEach(([key, value]) => {
							headersObj[key] = value;
						});
					} else {
						Object.entries(headers).forEach(([key, value]) => {
							headersObj[key] = value as string;
						});
					}
				};

				if (input instanceof Request) {
					extractHeaders(input.headers);
				}
				if (init?.headers) {
					extractHeaders(init.headers);
				}

				// Ensure cookie is present if we have it
				if (userCookie && !headersObj.cookie && !headersObj.Cookie) {
					headersObj.Cookie = userCookie;
				}

				const body = init?.body
					? init.body
					: input instanceof Request
						? await input.blob()
						: null;

				const method =
					init?.method || (input instanceof Request ? input.method : "GET");

				return fetch(proxyUrl.toString(), {
					method: method,
					headers: {
						"X-Proxy-Headers": JSON.stringify(headersObj),
					},
					body: body as BodyInit,
				});
			},
		});
	}

	return youtube;
}

export async function getUserProfile() {
	const client = await getYoutubeClient();
	try {
		const info = await client.account.getInfo();

		if (!info.contents || !info.contents.contents) return null;

		const accountItem = info.contents.contents.find(
			(item) => item.is(YTNodes.AccountItem) && item.is_selected,
		);

		if (accountItem?.is(YTNodes.AccountItem)) {
			return {
				name: accountItem.account_name.text,
				photo: accountItem.account_photo?.[0]?.url,
			};
		}

		return null;
	} catch (error) {
		console.error("Failed to get user profile:", error);
		return null;
	}
}

export async function getUserPlaylists() {
	const client = await getYoutubeClient();
	try {
		const library = await client.music.getLibrary();
		// The library usually contains sections like "Recent activity", "Playlists", etc.
		// We want to find the playlists section or just return everything for now to inspect
		return library;
	} catch (error) {
		console.error("Failed to get playlists:", error);
		return null;
	}
}

export async function getPlaylist(id: string) {
	const client = await getYoutubeClient();
	try {
		const playlist = await client.music.getPlaylist(id);
		return playlist;
	} catch (error) {
		console.error("Failed to get playlist:", error);
		return null;
	}
}

export async function getSongStream(videoId: string) {
	const client = await getYoutubeClient();
	const info = await client.music.getInfo(videoId);
	console.log(info);
	const format = info.chooseFormat({ type: "audio", quality: "best" });

	console.log(format);

	if (!format) {
		throw new Error("No suitable audio format found");
	}

	// Check if the format has a direct URL or needs deciphering
	if (format.url) {
		return format.url;
	}

	// If no direct URL, try to decipher
	return format.decipher(client.session.player);
}
