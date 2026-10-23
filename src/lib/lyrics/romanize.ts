import { useEffect, useMemo, useState } from "react";
import { RomanizeClient } from "./romanize-client";

const romanizer = new RomanizeClient(
	() =>
		new Worker(new URL("./romanize.worker.ts", import.meta.url), {
			type: "module",
		}),
);

/** Shared empty result: nothing worth showing under the lines. */
const EMPTY: Map<number, string> = new Map();

/**
 * Comparison key for "does the reading say anything new": ignores case,
 * width (NFKC folds full-width Latin), whitespace and punctuation, which
 * romanizers tend to normalize on their own.
 */
function readingKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Whether any line contains a script that romanization could change. Lyrics
 * written entirely in Latin script (plus digits, punctuation, symbols) are
 * skipped up front, so they never wait on the romanizer.
 */
function needsRomanization(lines: string[]): boolean {
	const nonLatin = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
	return lines.some((line) => nonLatin.test(line));
}

/**
 * Romanizes a batch of lines. Missing/failing lines are omitted. When every
 * reading matches its original line, the result is empty: showing the same
 * text twice adds nothing.
 */
export async function romanizeLines(
	lines: string[],
	signal?: AbortSignal,
): Promise<Map<number, string>> {
	const map = new Map<number, string>();
	if (lines.length === 0) return map;
	try {
		const result = await romanizer.request(lines, signal);
		result.forEach((line, i) => {
			const trimmed = line?.trim();
			if (trimmed) map.set(i, trimmed);
		});
	} catch {
		// romanization is best-effort
	}
	for (const [i, reading] of map) {
		if (readingKey(reading) !== readingKey(lines[i] ?? "")) return map;
	}
	return EMPTY;
}

export async function romanizeLine(text: string): Promise<string | null> {
	try {
		const [result] = await romanizer.request([text]);
		const trimmed = result?.trim();
		return trimmed && readingKey(trimmed) !== readingKey(text) ? trimmed : null;
	} catch {
		return null;
	}
}

/**
 * Computes romanizations for a list of lines reactively. Returns null while
 * pending, then a line-index → reading map (empty when there is nothing to
 * show, e.g. lyrics already in Latin script).
 */
export function useRomanizedLines(
	lines: string[],
	enabled: boolean,
): Map<number, string> | null {
	const needed = useMemo(
		() => enabled && lines.length > 0 && needsRomanization(lines),
		[enabled, lines],
	);
	const [map, setMap] = useState<Map<number, string> | null>(null);

	useEffect(() => {
		if (!needed) {
			setMap(null);
			return;
		}
		let cancelled = false;
		const controller = new AbortController();
		setMap(null);
		romanizeLines(lines, controller.signal).then((result) => {
			if (!cancelled) setMap(result);
		});
		return () => {
			cancelled = true;
			controller.abort();
		};
	}, [needed, lines]);

	if (!enabled) return null;
	// Nothing to romanize: settle immediately, no pending state to wait on.
	return needed ? map : EMPTY;
}
