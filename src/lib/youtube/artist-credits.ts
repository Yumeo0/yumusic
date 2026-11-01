import type { Song } from "@/contexts/player-context";
import { formatArtistName } from "../utils/title";

type ArtistCredit = { name: string; id?: string };
const key = (name: string) =>
	formatArtistName(name.replace(/\s*-\s*Topic$/i, ""))
		.normalize("NFKC")
		.trim()
		.toLowerCase();

/** Enrich matching credits without assigning an unrelated uploader to an artist. */
export function applyArtistCredits(song: Song, credits: ArtistCredit[]): Song {
	const linked = credits.filter((credit) => credit.id?.startsWith("UC"));
	if (!linked.length) return song;
	const placeholder =
		!song.artist.trim() || /^unknown artist$/i.test(song.artist.trim());
	const existing = song.artists?.length
		? song.artists
		: placeholder
			? credits
			: [{ name: song.artist, id: song.artistId }];
	const artists = existing.map((artist) => ({
		...artist,
		id:
			artist.id ??
			linked.find((credit) => key(credit.name) === key(artist.name))?.id,
	}));
	const primary =
		artists.find((artist) => key(artist.name) === key(song.artist)) ??
		artists[0];
	const creditIds = [...(song.creditIds ?? [])];
	for (const credit of linked) {
		const known = creditIds.find(
			(entry) => key(entry.name) === key(credit.name),
		);
		if (!known && credit.id)
			creditIds.push({ name: credit.name, id: credit.id });
	}
	return {
		...song,
		artist: placeholder
			? artists.map((artist) => artist.name).join(", ")
			: song.artist,
		artists,
		artistId: song.artistId ?? primary?.id,
		creditIds,
	};
}
