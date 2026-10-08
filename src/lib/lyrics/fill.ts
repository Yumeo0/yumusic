/** Pure timing helpers for the lyrics panel's karaoke fill. */

/**
 * Fraction of a span sung at `position` (0-1) — the left-to-right highlight
 * fill runs from its start to its end time. Zero-length spans (end at or
 * before start) light up whole as soon as they begin.
 */
export function wordProgress(
	start: number,
	end: number,
	position: number,
): number {
	if (position < start) return 0;
	if (end <= start) return 1;
	return Math.min(1, (position - start) / (end - start));
}

export interface ReadingSegment {
	text: string;
	/** Offset of the segment in the full reading, for stable keys. */
	start: number;
	/** Sung fraction (0-1); undefined for whitespace. */
	sung?: number;
}

/**
 * Splits a romanized reading into render segments for the karaoke fill:
 * whitespace stays plain, word segments carry how much of them is sung —
 * mapped character-proportionally from `progress`, the sung fraction of the
 * whole reading (the readings have no timings of their own).
 */
export function readingSegments(
	text: string,
	progress: number,
): ReadingSegment[] {
	if (text === "") return [];
	const segments: ReadingSegment[] = [];
	let start = 0;
	for (const part of text.split(/(\s+)/)) {
		segments.push({
			text: part,
			start,
			sung:
				part.trim() === ""
					? undefined
					: Math.min(
							1,
							Math.max(0, (progress * text.length - start) / part.length),
						),
		});
		start += part.length;
	}
	return segments;
}
