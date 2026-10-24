export interface LyricSection {
	title: string;
	credit?: string;
}

/** Standalone bracketed labels are structure; inline brackets remain lyrics. */
export function parseLyricSection(text: string): LyricSection | null {
	const match = text.trim().match(/^\[([^[\]\r\n]+)\]$/u);
	const label = match?.[1].trim();
	if (
		!label ||
		/^\d{1,3}:\d{2}(?:[.:]\d+)?$/.test(label) ||
		/^(?:ar|ti|al|by|offset|length|re|ve):/i.test(label)
	)
		return null;
	const colon = label.indexOf(":");
	const title = (colon < 0 ? label : label.slice(0, colon)).trim();
	if (!title) return null;
	const credit =
		colon < 0 ? undefined : label.slice(colon + 1).trim() || undefined;
	return credit ? { title, credit } : { title };
}
