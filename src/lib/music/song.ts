export interface Song {
	id: string;
	title: string;
	artist: string;
	/** Room username that added this particular queue entry. */
	addedBy?: string;
	/** Channel id (UC…) of the primary artist, when known */
	artistId?: string;
	/** All artists with their channel ids, when known */
	artists?: Array<{ name: string; id?: string }>;
	thumbnail: string;
	duration?: string;
	/** Uploader description; its credits refine the title and artist. */
	description?: string;
	/**
	 * Uploader video without a music release behind it (no album). Its title
	 * is the uploader's own string — e.g. "かめりあ - Towards the Horizon" —
	 * and is shown as-is instead of being read as an original/translation
	 * pair. Undefined means "not checked" (normal parsing).
	 */
	upload?: boolean;
	/**
	 * Channel ids for credited names from the description ("Vocal：湊あくあ"
	 * next to a channel link), so featured performers link their artist page
	 * like the primary artist does.
	 */
	creditIds?: Array<{ name: string; id: string }>;
}
