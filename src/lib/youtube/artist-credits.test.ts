import { expect, test } from "bun:test";
import type { Song } from "@/contexts/player-context";
import { applyArtistCredits } from "./artist-credits";

const base = {
	id: "KULEu9Z52sg",
	title: "C.S.Q.N. (2026 Remaster)",
	artist: "Aoi",
	thumbnail: "",
};

test("the supplied Aoi and DJ Noriken tracks acquire their verified artist links", () => {
	const aoi = "UCdZRmmdzlfazTzVKidNNA2A";
	expect(applyArtistCredits(base, [{ name: "Aoi", id: aoi }])).toMatchObject({
		title: base.title,
		artistId: aoi,
		artists: [{ name: "Aoi", id: aoi }],
	});
	const noriken = "UCFc26-iwlYbHKkZkYA8AiwQ";
	expect(
		applyArtistCredits({ ...base, id: "miUn-GLcd3Q", artist: "DJ Noriken" }, [
			{ name: "DJ Noriken", id: noriken },
		]).artistId,
	).toBe(noriken);
});
test("unrelated channels do not become artist links and existing links survive", () => {
	expect(
		applyArtistCredits(base, [{ name: "Someone Else", id: "UCother" }])
			.artistId,
	).toBeUndefined();
	expect(
		applyArtistCredits({ ...base, artistId: "UCknown" }, [
			{ name: "Aoi", id: "UCalternate" },
		]).artistId,
	).toBe("UCknown");
	expect(applyArtistCredits(base, [])).toBe(base);
});
test("description credits keep their names while missing matching ids are filled", () => {
	const song: Song = {
		...base,
		artist: "Aoi, Guest",
		artists: [{ name: "Aoi" }, { name: "Guest", id: "UCguest" }],
	};
	const enriched = applyArtistCredits(song, [
		{ name: "Aoi - Topic", id: "UCaoi" },
	]);
	expect(enriched.artist).toBe(song.artist);
	expect(enriched.artists).toEqual([
		{ name: "Aoi", id: "UCaoi" },
		{ name: "Guest", id: "UCguest" },
	]);
});
