export interface LrcLine {
	/** Start time in seconds */
	time: number;
	text: string;
	/** Word/syllable timings, when the provider offers them. */
	words?: LrcWord[];
}

/** A word/syllable timing within a synced line (karaoke highlighting). */
export interface LrcWord {
	/** Start time in seconds. */
	time: number;
	/** End time in seconds, when the provider knows it. */
	end?: number;
	text: string;
}

/**
 * How detailed a provider's lyrics are, simplest first. "word" is reserved
 * for word-by-word timing (karaoke-style) if a provider integration grows it.
 */
export type LyricsKind = "plain" | "synced" | "word";

/** Timing level of the lyrics a provider payload actually carries. */
export function lyricsKind(lyrics: { synced: LrcLine[] | null }): LyricsKind {
	if (!lyrics.synced) return "plain";
	return lyrics.synced.some((line) => line.words && line.words.length > 0)
		? "word"
		: "synced";
}

/** What the display picker needs to know about a provider's lyrics. */
export interface SelectableLyrics {
	synced: LrcLine[] | null;
	/** Matched on artist + title (or authoritative), not a loose match. */
	confirmed: boolean;
}

export interface ProviderLyrics extends SelectableLyrics {
	plain: string | null;
}
