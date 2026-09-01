import { createRomanizer } from "lyric-romanizer";
import { useEffect, useState } from "react";

const romanizer = createRomanizer();

/** Romanizes a batch of lines. Missing/failing lines are omitted. */
export async function romanizeLines(
	lines: string[],
): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	if (lines.length === 0) return map;
	try {
		const result = await romanizer.romanizeLines(lines);
		result.lines.forEach((line, i) => {
			const trimmed = line?.trim();
			if (trimmed) map.set(i, trimmed);
		});
	} catch {
		// romanization is best-effort
	}
	return map;
}

export async function romanizeLine(text: string): Promise<string | null> {
	try {
		const result = await romanizer.romanizeLine(text);
		return result?.trim() ? result.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Computes romanizations for a list of lines reactively. Returns
 * null while pending, then a line-index → reading map.
 */
export function useRomanizedLines(
	lines: string[],
	enabled: boolean,
): Map<number, string> | null {
	const [map, setMap] = useState<Map<number, string> | null>(null);

	useEffect(() => {
		if (!enabled || lines.length === 0) {
			setMap(null);
			return;
		}
		let cancelled = false;
		setMap(null);
		romanizeLines(lines).then((result) => {
			if (!cancelled) setMap(result);
		});
		return () => {
			cancelled = true;
		};
	}, [enabled, lines]);

	return map;
}
