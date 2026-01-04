import { BG, type BgConfig } from "bgutils-js";
import { JSDOM } from "jsdom";
import { Innertube, UniversalCache } from "youtubei.js/web";

export async function generateWebPoToken() {
	// Create a barebones Innertube instance to get visitor data from YouTube
	const innertube = await Innertube.create({
		retrieve_player: false,
		cache: new UniversalCache(true),
	});

	const requestKey = "O43z0dpjhgX20SCx4KAo";
	const visitorData = innertube.session.context.client.visitorData;

	if (!visitorData) throw new Error("Could not get visitor data");

	// Decode the URL-encoded visitor data to get the actual base64 string
	const decodedVisitorData = decodeURIComponent(visitorData);

	const dom = new JSDOM();

	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
	});

	const bgConfig: BgConfig = {
		fetch: (input: string | URL | globalThis.Request, init?: RequestInit) =>
			fetch(input, init),
		globalObj: globalThis,
		identifier: decodedVisitorData,
		requestKey,
	};

	const bgChallenge = await BG.Challenge.create(bgConfig);

	if (!bgChallenge) throw new Error("Could not get challenge");

	const interpreterJavascript =
		bgChallenge.interpreterJavascript
			.privateDoNotAccessOrElseSafeScriptWrappedValue;

	if (interpreterJavascript) {
		new Function(interpreterJavascript)();
	} else throw new Error("Could not load VM");

	const poTokenResult = await BG.PoToken.generate({
		program: bgChallenge.program,
		globalName: bgChallenge.globalName,
		bgConfig,
	});

	return {
		visitorData: decodedVisitorData,
		poToken: poTokenResult.poToken,
	};
}
