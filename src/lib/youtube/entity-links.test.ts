import { expect, test } from "bun:test";
import { findYouTubeLink, youTubeLinkRoute } from "./entity-links";

const channel = "UCy0tKL1T7wFoYcxCe0xjN6Q";
function requireLink(url: string) {
	const link = findYouTubeLink(url);
	if (!link) throw new Error(`Expected a supported link: ${url}`);
	return link;
}
test("channel, handle, playlist and album links are recognized in pasted messages", () => {
	expect(findYouTubeLink(`youtube.com/channel/${channel}`)).toMatchObject({
		kind: "channel",
		id: channel,
	});
	expect(
		findYouTubeLink(
			"Try https://www.youtube.com/@TechnologyConnections/videos, thanks.",
		),
	).toMatchObject({
		kind: "channel",
		url: "https://www.youtube.com/@TechnologyConnections/videos",
	});
	expect(
		findYouTubeLink(
			"https://music.youtube.com/playlist?list=OLAK5uy_example&si=share",
		),
	).toMatchObject({ kind: "collection", id: "OLAK5uy_example" });
	expect(
		findYouTubeLink("https://music.youtube.com/browse/MPREb_n9pnkzIyWxi"),
	).toMatchObject({ kind: "collection", id: "MPREb_n9pnkzIyWxi" });
	expect(findYouTubeLink("https://youtube.com/c/SomeChannel")).toMatchObject({
		kind: "channel",
	});
	expect(findYouTubeLink("https://youtube.com/user/SomeChannel")).toMatchObject(
		{ kind: "channel" },
	);
});
test("songs keep the preview even when their URL also includes a playlist", () => {
	expect(
		findYouTubeLink(
			"https://music.youtube.com/watch?v=KULEu9Z52sg&list=OLAK5uy_example",
		),
	).toMatchObject({ kind: "video", id: "KULEu9Z52sg" });
	expect(
		findYouTubeLink("https://youtu.be/miUn-GLcd3Q?si=share"),
	).toMatchObject({ kind: "video", id: "miUn-GLcd3Q" });
});

test("mobile entry links include Music home, search, library, podcasts and public mixes", async () => {
	const resolve = async () => {
		throw new Error("Direct links need no resolver");
	};
	for (const [url, route] of [
		["https://music.youtube.com/", "/"],
		["https://music.youtube.com/explore", "/"],
		["https://music.youtube.com/library/playlists", "/playlists"],
		["https://music.youtube.com/search?q=Aoi%20remix", "/?q=Aoi%20remix"],
		["https://music.youtube.com/browse/FEmusic_library_landing", "/playlists"],
		["https://music.youtube.com/podcast/PLexample", "/playlists/PLexample"],
		[
			"https://music.youtube.com/playlist?list=RDATjuUCexample",
			"/playlists/RDATjuUCexample",
		],
	])
		expect(await youTubeLinkRoute(requireLink(url), resolve)).toBe(route);
	expect(findYouTubeLink("https://music.youtube.com/@_yumeo_")).toMatchObject({
		kind: "channel",
	});
});
test("foreign hosts, credentials, invalid ids and unrelated YouTube URLs are ignored", () => {
	for (const url of [
		"https://youtube.com.evil.test/@artist",
		"https://youtube.com@evil.test/channel/UC123",
		"https://user:pass@youtube.com/@artist",
		"https://youtube.com/results?search_query=test",
		"https://youtube.com/playlist?list=bad%2Fid",
	])
		expect(findYouTubeLink(url)).toBeNull();
});
test("handles resolve through YouTube, while direct browse IDs need no network request", async () => {
	let requests = 0;
	const resolve = async () => {
		requests++;
		return { payload: { browseId: channel } };
	};
	expect(
		await youTubeLinkRoute(
			requireLink("https://youtube.com/@TechnologyConnections"),
			resolve,
		),
	).toBe(`/artist/${channel}`);
	expect(
		await youTubeLinkRoute(
			requireLink("https://music.youtube.com/browse/MPREb_n9pnkzIyWxi"),
			resolve,
		),
	).toBe("/playlists/MPREb_n9pnkzIyWxi");
	expect(requests).toBe(1);
	await expect(
		youTubeLinkRoute(requireLink("https://youtube.com/@invalid"), async () => ({
			payload: { browseId: "FEwhat_to_watch" },
		})),
	).rejects.toThrow("supported YouTube channel");
});
