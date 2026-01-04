import { Innertube, UniversalCache } from "youtubei.js/web";
import { generateWebPoToken } from "./src/lib/webpo.lib.js";

async function testSearch() {
	try {
		console.log("Generating po_token...");
		const po_token = await generateWebPoToken();

		console.log("Creating Innertube instance...");
		const youtube = await Innertube.create({
			po_token: po_token.poToken,
			visitor_data: po_token.visitorData,
			cache: new UniversalCache(true),
			generate_session_locally: true,
		});

		console.log("Searching for 'Better Luck Next Time'...");
		const _search = await youtube.music.search("Better Luck Next Time");
		const _songs = _search.songs;
		console.log("Search completed.");
	} catch (error) {
		console.error("Error:", error);
	}
}

testSearch();
