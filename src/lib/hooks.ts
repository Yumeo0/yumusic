import { useEffect, useState } from "react";
import { proxiedImageUrl } from "./tauri";

const MAX_VOLUME = 0.15;

/** Map a linear slider position [0,1] to an exponential volume curve. */
export function linearToVolume(linear: number): number {
	return ((Math.exp(linear) - 1) / (Math.E - 1)) * MAX_VOLUME;
}

/** Map an exponential volume back to a linear slider position [0,1]. */
export function volumeToLinear(volume: number): number {
	return Math.log((volume / MAX_VOLUME) * (Math.E - 1) + 1);
}

export { MAX_VOLUME };

/**
 * Tracks currentTime / duration of a media element via timeupdate events.
 * Keeps re-renders local to the calling component (no context churn at 4Hz).
 * `resetKey` (e.g. the song id) zeroes both values immediately when it
 * changes, so the UI shows 00:00 while the next track is still loading.
 */
export function useMediaTime(
	videoElementRef: React.RefObject<HTMLVideoElement | null> | null,
	resetKey?: string,
) {
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);

	useEffect(() => {
		// Skip only when no track has played yet (state is already zero)
		if (resetKey === undefined) return;
		setCurrentTime(0);
		setDuration(0);
	}, [resetKey]);

	useEffect(() => {
		const videoEl = videoElementRef?.current;
		if (!videoEl) return;

		const handleLoadedMetadata = () => {
			if (Number.isFinite(videoEl.duration)) setDuration(videoEl.duration);
		};
		const handleTimeUpdate = () => {
			setCurrentTime(videoEl.currentTime);
			if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
				setDuration(videoEl.duration);
			}
		};

		handleLoadedMetadata();
		if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
			setDuration(videoEl.duration);
		}

		videoEl.addEventListener("loadedmetadata", handleLoadedMetadata);
		videoEl.addEventListener("timeupdate", handleTimeUpdate);
		return () => {
			videoEl.removeEventListener("loadedmetadata", handleLoadedMetadata);
			videoEl.removeEventListener("timeupdate", handleTimeUpdate);
		};
	}, [videoElementRef]);

	return { currentTime, duration };
}

/* ─── Ambient album color extraction ─────────────────────────── */

const AMBIENT_STORAGE_KEY = "yumusic-ambient-colors";
const AMBIENT_MAX_ENTRIES = 256;

const ambientCache = new Map<string, string>();
/** URLs whose extraction failed — not re-probed this session (429 hammering guard). */
const ambientFailures = new Set<string>();
const ambientInflight = new Map<string, Promise<string | null>>();

/** Loads persisted colors once at startup; the map is tiny (url -> rgb string). */
function hydrateAmbientCache() {
	try {
		const raw = localStorage.getItem(AMBIENT_STORAGE_KEY);
		if (!raw) return;
		const stored = JSON.parse(raw) as Record<string, string>;
		for (const [url, color] of Object.entries(stored)) {
			ambientCache.set(url, color);
		}
	} catch {
		// corrupted store — start fresh in memory
	}
}
hydrateAmbientCache();

/** Persists the color map, bounding its size to keep localStorage small. */
function persistAmbientCache() {
	try {
		while (ambientCache.size > AMBIENT_MAX_ENTRIES) {
			const oldest = ambientCache.keys().next().value;
			if (oldest === undefined) break;
			ambientCache.delete(oldest);
		}
		localStorage.setItem(
			AMBIENT_STORAGE_KEY,
			JSON.stringify(Object.fromEntries(ambientCache)),
		);
	} catch {
		// quota exceeded or storage unavailable — keep in-memory only
	}
}

function boostColor(r: number, g: number, b: number): string {
	// Pick the most vivid pixel: score by saturation + brightness
	const max = Math.max(r, g, b) || 1;
	const min = Math.min(r, g, b);
	const sat = (max - min) / max;
	// Scale so the color works as an accent on a dark background:
	// not blinding bright, not invisible dark
	const target = 205;
	const scale = Math.min(target / max, 2.6);
	let nr = Math.round(Math.min(255, r * scale));
	let ng = Math.round(Math.min(255, g * scale));
	let nb = Math.round(Math.min(255, b * scale));
	// Lift very dark colors just enough to stay visible
	const lum = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
	if (lum < 80) {
		const lift = Math.min(80 / Math.max(lum, 1), 1.8);
		nr = Math.round(Math.min(255, nr * lift + 12));
		ng = Math.round(Math.min(255, ng * lift + 12));
		nb = Math.round(Math.min(255, nb * lift + 12));
	}
	// Blend a touch of warmth so near-grayscale covers still feel at home
	if (sat < 0.18) {
		nr = Math.round(nr * 0.92 + 24);
		ng = Math.round(ng * 0.8 + 18);
		nb = Math.round(nb * 0.45 + 8);
	}
	return `rgb(${nr}, ${ng}, ${nb})`;
}

function extractDominantColor(
	bitmap: ImageBitmap | HTMLImageElement,
): string | null {
	const size = 32;
	const canvas = document.createElement("canvas");
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return null;
	ctx.drawImage(bitmap, 0, 0, size, size);
	const { data } = ctx.getImageData(0, 0, size, size);
	let best = { score: -1, r: 255, g: 19, b: 74 };
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const sat = max === 0 ? 0 : (max - min) / max;
		const score = sat * 1.7 + (max / 255) * 0.5;
		if (score > best.score) best = { score, r, g, b };
	}
	return boostColor(best.r, best.g, best.b);
}

/**
 * Extracts the dominant ambient color with as little network traffic as
 * possible: on-screen artwork is served through the Tauri proxy (which adds
 * CORS headers), so this fetch reuses the proxy's in-memory image cache —
 * request-free for covers already on screen, no extra upstream download.
 * Returns null on any failure.
 */
async function extractFromUrl(url: string): Promise<string | null> {
	try {
		const res = await fetch(proxiedImageUrl(url), { mode: "cors" });
		if (!res.ok) return null;
		const blob = await res.blob();
		const bitmap = await createImageBitmap(blob);
		const color = extractDominantColor(bitmap);
		bitmap.close();
		return color;
	} catch {
		// proxy unreachable or unusable response
		return null;
	}
}

/**
 * Extracts a dominant ambient color from an album thumbnail.
 * Falls back to the theme red when the image is missing or CORS-blocked.
 * Results are cached in memory + localStorage; failures are negative-cached
 * for the session so rate-limited (429) URLs are never hammered.
 */
export function useAmbientColor(imageUrl: string | undefined): string {
	const [color, setColor] = useState(
		() => (imageUrl && ambientCache.get(imageUrl)) || "rgb(255, 19, 74)",
	);

	useEffect(() => {
		if (!imageUrl) return;
		const cached = ambientCache.get(imageUrl);
		if (cached) {
			setColor(cached);
			return;
		}
		if (ambientFailures.has(imageUrl)) return;
		let cancelled = false;
		let request = ambientInflight.get(imageUrl);
		if (!request) {
			request = extractFromUrl(imageUrl)
				.then((extracted) => {
					if (extracted) {
						ambientCache.set(imageUrl, extracted);
						persistAmbientCache();
					} else {
						ambientFailures.add(imageUrl);
						console.warn("[ambient] failed to extract color from", imageUrl);
					}
					return extracted;
				})
				.finally(() => {
					ambientInflight.delete(imageUrl);
				});
			ambientInflight.set(imageUrl, request);
		}
		request.then((extracted) => {
			if (!cancelled && extracted) setColor(extracted);
		});
		return () => {
			cancelled = true;
		};
	}, [imageUrl]);

	return color;
}
