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
 * Rewrites a YouTube thumbnail URL to a larger variant. YT Music often
 * returns 60-120px sources; rendering those above ~100px looks blurry.
 */
export function hiResThumb(url: string | undefined | null, size = 544): string {
	if (!url) return "";
	// Google-hosted art (library, playlists, music search): size lives in the
	// "=wNN-hNN..." suffix
	if (
		url.includes("googleusercontent.com") ||
		url.includes("ggpht.com") ||
		url.includes("ytimg.l.google.com")
	) {
		const base = url.split("=")[0];
		return `${base}=w${size}-h${size}-l90-rj`;
	}
	// i.ytimg.com video thumbnails: swap the variant file
	if (url.includes("i.ytimg.com")) {
		return url.replace(
			/\/(default|mqdefault|sddefault|hqdefault|maxresdefault)\.jpg/,
			size > 400 ? "/maxresdefault.jpg" : "/mqdefault.jpg",
		);
	}
	return url;
}
