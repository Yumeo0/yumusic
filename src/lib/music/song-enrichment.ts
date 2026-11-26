import { applySongDescription } from "@/lib/utils/description";
import type { Song } from "./song";

export interface SongEnrichment {
	description?: string;
	upload?: true;
}

export function applySongEnrichment<S extends Song>(
	song: S,
	enrichment: SongEnrichment,
): S {
	const { description, upload } = enrichment;
	const described =
		description && !song.description
			? applySongDescription(song, description)
			: song;
	return upload && described.upload === undefined
		? { ...described, upload }
		: described;
}
