/** The fixed row older app versions hid through a dedicated flag. */
export const TODAYS_BIGGEST_HITS = "Today's biggest hits";

/** Case/punctuation-stable key for a home section title. */
export function normalizeHomeSectionTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'");
}

/** Whether any of the hidden titles match this section (case-insensitively). */
export function isHomeSectionHidden(
	title: string,
	hidden: readonly string[],
): boolean {
	const key = normalizeHomeSectionTitle(title);
	return hidden.some((entry) => normalizeHomeSectionTitle(entry) === key);
}

/** Adds a title to the hidden list, leaving an existing match untouched. */
export function hideHomeSection(
	hidden: readonly string[],
	title: string,
): string[] {
	const trimmed = title.trim();
	if (!trimmed || isHomeSectionHidden(trimmed, hidden)) return [...hidden];
	return [...hidden, trimmed];
}

/** Removes a title from the hidden list (case-insensitively). */
export function showHomeSection(
	hidden: readonly string[],
	title: string,
): string[] {
	const key = normalizeHomeSectionTitle(title);
	return hidden.filter((entry) => normalizeHomeSectionTitle(entry) !== key);
}

/**
 * Reads the hidden-section list from settings, including the one-off
 * `hideTodaysBiggestHits` flag used before hiding became generic.
 */
export function normalizeHiddenHomeSections(
	value: unknown,
	legacyHideTodaysBiggestHits?: unknown,
): string[] {
	const source = Array.isArray(value)
		? value
		: legacyHideTodaysBiggestHits === true
			? [TODAYS_BIGGEST_HITS]
			: [];
	const seen = new Set<string>();
	const hidden: string[] = [];
	for (const entry of source) {
		if (typeof entry !== "string") continue;
		const title = entry.trim();
		if (!title) continue;
		const key = normalizeHomeSectionTitle(title);
		if (seen.has(key)) continue;
		seen.add(key);
		hidden.push(title);
	}
	return hidden;
}
