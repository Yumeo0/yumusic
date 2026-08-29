import { useEffect, useRef, useState } from "react";
import { hiResThumb } from "@/lib/utils";

interface ThumbProps extends React.ImgHTMLAttributes<HTMLImageElement> {
	src?: string;
}

/**
 * App-level thumbnail cache: original URL -> best working URL.
 * Survives component mounts, so the hi-res probe (and its 404 fallback)
 * happens only once per image across the whole app.
 */
const resolvedCache = new Map<string, string>();
const pendingProbes = new Map<string, Promise<string>>();

function probeHiRes(original: string): Promise<string> {
	const existing = pendingProbes.get(original);
	if (existing) return existing;

	const hi = hiResThumb(original);
	if (hi === original) return Promise.resolve(original);

	const probe = new Promise<string>((resolve) => {
		const img = new Image();
		img.onload = () => resolve(hi);
		img.onerror = () => resolve(original);
		img.src = hi;
	}).then((resolved) => {
		resolvedCache.set(original, resolved);
		pendingProbes.delete(original);
		return resolved;
	});
	pendingProbes.set(original, probe);
	return probe;
}

/**
 * Image that resolves the best-quality thumbnail variant once per URL.
 * With loading="lazy", nothing is fetched until the image approaches the
 * viewport (checked via IntersectionObserver, since the probe bypasses
 * native lazy loading). Falls back to the original URL if the hi-res
 * variant doesn't exist (404).
 */
export function Thumb({ src, alt = "", loading, ...rest }: ThumbProps) {
	const [current, setCurrent] = useState(() =>
		src ? (resolvedCache.get(src) ?? src) : "",
	);
	const imgRef = useRef<HTMLImageElement>(null);
	const eager = loading !== "lazy";

	useEffect(() => {
		if (!src) {
			setCurrent("");
			return;
		}
		const cached = resolvedCache.get(src);
		if (cached) {
			setCurrent(cached);
			return;
		}
		let cancelled = false;
		// Show the known-good original immediately, upgrade when appropriate
		setCurrent(src);

		const upgrade = () => {
			probeHiRes(src).then((resolved) => {
				if (!cancelled) setCurrent(resolved);
			});
		};

		if (eager) {
			upgrade();
			return () => {
				cancelled = true;
			};
		}

		const el = imgRef.current;
		if (!el || typeof IntersectionObserver === "undefined") {
			upgrade();
			return () => {
				cancelled = true;
			};
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					observer.disconnect();
					upgrade();
				}
			},
			{ rootMargin: "400px" },
		);
		observer.observe(el);
		return () => {
			cancelled = true;
			observer.disconnect();
		};
	}, [src, eager]);

	return (
		<img alt={alt} loading={loading} ref={imgRef} src={current} {...rest} />
	);
}
