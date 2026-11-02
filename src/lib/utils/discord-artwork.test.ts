import { expect, test } from "bun:test";
import { discordArtworkUrl } from "./discord-artwork";

test("Discord receives a fetchable square image with detected borders removed before resize", () => {
	const source = "https://i.ytimg.com/vi/video/hqdefault.jpg?test=1&size=2";
	const result = new URL(
		discordArtworkUrl(source, { top: 0.125, bottom: 0.125 }),
	);
	expect(result.origin).toBe("https://wsrv.nl");
	expect(result.searchParams.get("url")).toBe(source);
	expect(result.searchParams.get("cy")).toBe("12.5%");
	expect(result.searchParams.get("ch")).toBe("75%");
	expect(result.searchParams.has("precrop")).toBe(true);
	expect(result.searchParams.get("fit")).toBe("cover");
	expect(result.searchParams.get("w")).toBe(result.searchParams.get("h"));
});

test("artwork without borders and local URLs are never sent to the crop service", () => {
	const source = "https://example.com/square.jpg";
	expect(discordArtworkUrl(source, null)).toBe(source);
	for (const local of [
		"blob:local",
		"data:image/png;base64,AA",
		"proxy://image",
	])
		expect(discordArtworkUrl(local, { top: 0.1, bottom: 0.1 })).toBe(local);
});
