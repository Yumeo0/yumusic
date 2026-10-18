import { useEffect, useState } from "react";

const HISTORY_KEY = "yumusic:search-history";
const HISTORY_EVENT = "yumusic:search-history-changed";

/** How many submitted queries the search bar keeps. */
export const MAX_RECENT_SEARCHES = 8;

export function getRecentSearches(): string[] {
	try {
		const raw = localStorage.getItem(HISTORY_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		return [];
	}
}

function saveRecentSearches(searches: string[]) {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(searches));
	} catch {
		// best-effort
	}
	window.dispatchEvent(new Event(HISTORY_EVENT));
}

/**
 * Records a submitted search, newest first. Repeated queries move to the top
 * instead of accumulating, and matching is case-insensitive.
 */
export function rememberSearch(query: string) {
	const trimmed = query.trim();
	if (!trimmed) return;
	const current = getRecentSearches();
	const key = trimmed.toLowerCase();
	saveRecentSearches(
		[trimmed, ...current.filter((entry) => entry.toLowerCase() !== key)].slice(
			0,
			MAX_RECENT_SEARCHES,
		),
	);
}

/** Removes one query from the recent list. */
export function forgetSearch(query: string) {
	const current = getRecentSearches();
	const key = query.toLowerCase();
	saveRecentSearches(current.filter((entry) => entry.toLowerCase() !== key));
}

export function clearRecentSearches() {
	if (getRecentSearches().length === 0) return;
	saveRecentSearches([]);
}

/** Shared reactive state for the search bar's recent queries. */
export function useRecentSearches() {
	const [searches, setSearches] = useState<string[]>(getRecentSearches);

	useEffect(() => {
		const refresh = () => setSearches(getRecentSearches());
		window.addEventListener(HISTORY_EVENT, refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener(HISTORY_EVENT, refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);

	return searches;
}
