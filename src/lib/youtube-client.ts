import { Innertube, UniversalCache, YTNodes } from "youtubei.js/web";

let youtube: Innertube | null = null;

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
