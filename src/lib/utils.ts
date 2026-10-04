import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Formats a track's total length. Rounds to the nearest second so it agrees
 * with the duration YouTube reports in listings (e.g. the playlist row): the
 * media element's exact duration (224.9s) would otherwise floor to `3:44`
 * while YouTube's rounded length text shows `3:45`.
 */
export function formatDuration(seconds: number): string {
	return formatTime(Number.isFinite(seconds) ? Math.round(seconds) : seconds);
}

/**
 * Parses a YouTube duration label ("2:55", "1:02:03") into seconds.
 * Returns 0 for missing/invalid input.
 */
export function parseDuration(text: string | undefined | null): number {
	if (!text) return 0;
	const parts = text.split(":").map((part) => Number.parseInt(part, 10));
	if (parts.some((part) => !Number.isFinite(part))) return 0;
	return parts.reduce((total, part) => total * 60 + part, 0);
}

/**
 * Rewrites a YouTube thumbnail URL to a larger variant. YT Music returns
 * tiny 60-120px sources; googleusercontent URLs accept any size parameter
 * (deterministic — no probing needed). i.ytimg.com URLs are returned as-is:
 * callers already select the highest variant contained in the API response.
 */
export function hiResThumb(url: string | undefined | null, size = 544): string {
	if (!url) return "";
	if (
		url.includes("googleusercontent.com") ||
		url.includes("ggpht.com") ||
		url.includes("ytimg.l.google.com")
	) {
		const base = url.split("=")[0];
		return `${base}=w${size}-h${size}-l90-rj`;
	}
	return url;
}

/**
 * Central-square view box for 16:9 i.ytimg video frames: they usually center
 * a square cover between baked-in side bars, which show once the artwork is
 * stretched into a wider-than-square container. Square YT Music covers (and
 * every other source) need no crop.
 */
export function coverViewBox(
	url: string | undefined | null,
): string | undefined {
	return url && /\/(?:maxresdefault|hq720|mqdefault)\.\w+/i.test(url)
		? "inset(0 21.875% 0 21.875%)"
		: undefined;
}

/** Entry of a YouTube thumbnail candidate list (e.g. basic_info.thumbnail). */
export interface ThumbCandidate {
	url: string;
	width?: number;
	height?: number;
}

/**
 * Picks the highest-resolution candidate from a YouTube thumbnail list,
 * ranked by pixel area. Returns undefined when the list is missing or empty.
 */
export function biggestThumb(
	thumbnail: readonly ThumbCandidate[] | null | undefined,
): ThumbCandidate | undefined {
	let best: ThumbCandidate | undefined;
	for (const candidate of thumbnail ?? []) {
		if (!candidate.url) continue;
		const area = (candidate.width ?? 0) * (candidate.height ?? 0);
		if (!best || area > (best.width ?? 0) * (best.height ?? 0)) {
			best = candidate;
		}
	}
	return best;
}
