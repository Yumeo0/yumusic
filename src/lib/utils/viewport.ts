import { useEffect, useState } from "react";

// Match the Tailwind md breakpoint used by the corresponding layouts.
export const MOBILE_QUERY = "(max-width: 767.98px)";
export const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * Tracks a CSS media query. Starts from the current match so the first paint
 * already uses the right layout, then follows viewport changes. Safe outside a
 * browser (returns false).
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(
		() => typeof window !== "undefined" && window.matchMedia(query).matches,
	);

	useEffect(() => {
		const media = window.matchMedia(query);
		const update = () => setMatches(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [query]);

	return matches;
}
