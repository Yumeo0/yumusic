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
 * (deterministic — no probing needed). URLs on other hosts are upgraded only
 * when they already carry a Google-style size suffix (e.g. custom playlist
 * covers served from music.youtube.com). i.ytimg.com URLs are returned as-is:
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
	const sizeSuffix = /=(?:w\d+-h\d+|s\d+)(?:-[a-z0-9]+)*$/i;
	if (sizeSuffix.test(url)) {
		return url.replace(sizeSuffix, `=w${size}-h${size}-l90-rj`);
	}
	return url;
}

/**
 * Central-square view box for i.ytimg video frames: they center a square cover
 * between baked-in bars (16:9 variants have side bars; 4:3 variants letterbox
 * the 16:9 frame), which show once the artwork is stretched into a
 * wider-than-square container. Square YT Music covers (and every other source)
 * need no crop.
 */
export function coverViewBox(
	url: string | undefined | null,
): string | undefined {
	if (!url) return undefined;
	if (/\/(?:maxresdefault|hq720|mqdefault)\.\w+/i.test(url)) {
		return "inset(0 21.875% 0 21.875%)";
	}
	if (/\/(?:hqdefault|sddefault|default)\.\w+/i.test(url)) {
		return "inset(12.5% 21.875% 12.5% 21.875%)";
	}
	return undefined;
}

/** Entry of a YouTube thumbnail candidate list (e.g. basic_info.thumbnail). */
export interface ThumbCandidate {
	url: string;
	width?: number;
	height?: number;
}

/**
 * Picks the highest-resolution candidate from a YouTube thumbnail list,
 * ranked by pixel area. Later entries win ties, so lists that omit dimensions
 * keep resolving to the last (largest-by-convention) variant. Returns
 * undefined when the list is missing or empty.
 */
export function biggestThumb(
	thumbnail: readonly ThumbCandidate[] | null | undefined,
): ThumbCandidate | undefined {
	let best: ThumbCandidate | undefined;
	for (const candidate of thumbnail ?? []) {
		if (!candidate.url) continue;
		const area = (candidate.width ?? 0) * (candidate.height ?? 0);
		if (!best || area >= (best.width ?? 0) * (best.height ?? 0)) {
			best = candidate;
		}
	}
	return best;
}

/** Human-readable file size (binary units, one decimal for MB/GB). */
export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}
