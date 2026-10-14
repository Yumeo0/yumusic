import { type Accessor, createEffect, createSignal, untrack } from "solid-js";
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
 * Keeps updates local to the calling component (no context churn at 4Hz).
 * `resetKey` (e.g. the song id) zeroes both values immediately when it
 * changes, so the UI shows 00:00 while the next track is still loading.
 * `knownDuration` (seconds from YouTube metadata, when available) takes
 * precedence over the media element's duration so the total matches the
 * length shown in listings.
 */
export function useMediaTime(
	getElement: () => HTMLVideoElement | null,
	resetKey?: Accessor<string | undefined>,
	knownDuration?: Accessor<number>,
) {
	const [currentTime, setCurrentTime] = createSignal(0);
	const [mediaDuration, setMediaDuration] = createSignal(0);

	// Re-attach on `resetKey` too: after a crossfade handover the active
	// element behind the getter changes without the ref itself doing
	// so, and the media clock must follow the deck that is now audible.
	// The element is snapshotted in the compute phase so the (reactive)
	// getter is only read inside tracking scope.
	createEffect(
		() => ({ element: getElement(), key: resetKey?.() }),
		({ element: videoEl }) => {
			setCurrentTime(0);
			setMediaDuration(0);

			if (!videoEl) return;

			const handleLoadedMetadata = () => {
				if (Number.isFinite(videoEl.duration))
					setMediaDuration(videoEl.duration);
			};
			const handleTimeUpdate = () => {
				setCurrentTime(videoEl.currentTime);
				if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
					setMediaDuration(videoEl.duration);
				}
			};

			handleLoadedMetadata();
			if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
				setMediaDuration(videoEl.duration);
			}

			videoEl.addEventListener("loadedmetadata", handleLoadedMetadata);
			videoEl.addEventListener("timeupdate", handleTimeUpdate);
			return () => {
				videoEl.removeEventListener("loadedmetadata", handleLoadedMetadata);
				videoEl.removeEventListener("timeupdate", handleTimeUpdate);
			};
		},
	);

	const duration = () => {
		const known = knownDuration?.();
		return known && known > 0 ? known : mediaDuration();
	};

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
export function useAmbientColor(
	imageUrl: Accessor<string | undefined>,
): Accessor<string> {
	const [color, setColor] = createSignal(
		untrack(() => {
			const url = imageUrl();
			return (url && ambientCache.get(url)) || "rgb(255, 19, 74)";
		}),
	);

	createEffect(
		() => imageUrl(),
		(url) => {
			if (!url) return;
			const cached = ambientCache.get(url);
			if (cached) {
				setColor(cached);
				return;
			}
			if (ambientFailures.has(url)) return;
			let cancelled = false;
			let request = ambientInflight.get(url);
			if (!request) {
				request = extractFromUrl(url)
					.then((extracted) => {
						if (extracted) {
							ambientCache.set(url, extracted);
							persistAmbientCache();
						} else {
							ambientFailures.add(url);
							console.warn("[ambient] failed to extract color from", url);
						}
						return extracted;
					})
					.finally(() => {
						ambientInflight.delete(url);
					});
				ambientInflight.set(url, request);
			}
			request.then((extracted) => {
				if (!cancelled && extracted) setColor(extracted);
			});
			return () => {
				cancelled = true;
			};
		},
	);

	return color;
}
