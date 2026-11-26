import { useEffect, useState } from "react";
import { DEFAULT_AMBIENT_COLOR, dominantAccentColor } from "./ambient-color";
import { LruCache } from "./lru-cache";
import { proxiedImageUrl } from "./tauri";

// Frequency-based extraction replaces the old single-pixel cached colors.
const AMBIENT_STORAGE_KEY = "yumusic-ambient-colors:v2";
const AMBIENT_MAX_ENTRIES = 256;

const ambientCache = new LruCache<string, string>(AMBIENT_MAX_ENTRIES);
/** URLs whose extraction failed — not re-probed this session (429 hammering guard). */
const ambientFailures = new LruCache<string, true>(AMBIENT_MAX_ENTRIES);
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
		localStorage.setItem(
			AMBIENT_STORAGE_KEY,
			JSON.stringify(Object.fromEntries(ambientCache)),
		);
	} catch {
		// quota exceeded or storage unavailable — keep in-memory only
	}
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
	return dominantAccentColor(data);
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
		const res = await fetch(proxiedImageUrl(url, 64), { mode: "cors" });
		if (!res.ok) return null;
		const blob = await res.blob();
		const bitmap = await createImageBitmap(blob, {
			resizeWidth: 32,
			resizeHeight: 32,
			resizeQuality: "low",
		});
		try {
			return extractDominantColor(bitmap);
		} finally {
			bitmap.close();
		}
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
		() => (imageUrl && ambientCache.get(imageUrl)) || DEFAULT_AMBIENT_COLOR,
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
						ambientFailures.set(imageUrl, true);
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
