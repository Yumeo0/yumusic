import type { LrcLine } from "./lyrics";

const TIME_TOKEN = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

export function stripLrcTimestamps(lrc: string): string {
	return lrc.replace(TIME_TOKEN, "");
}

export function parseLrc(lrc: string): LrcLine[] {
	const lines: LrcLine[] = [];
	let offsetMs = 0;

	for (const raw of lrc.split("\n")) {
		const meta = raw.match(
			/^\s*\[(ar|ti|al|by|offset|re|ve|length):(.*)\]\s*$/i,
		);
		if (meta) {
			if (meta[1].toLowerCase() === "offset") {
				offsetMs = Number.parseInt(meta[2], 10) || 0;
			}
			continue;
		}
		const timestamps = [...raw.matchAll(TIME_TOKEN)];
		if (timestamps.length === 0) continue;
		const text = stripLrcTimestamps(raw).trim();
		for (const t of timestamps) {
			const min = Number.parseInt(t[1], 10);
			const sec = Number.parseInt(t[2], 10);
			const frac = t[3] ? Number.parseInt(t[3].padEnd(3, "0"), 10) : 0;
			lines.push({ time: min * 60 + sec + frac / 1000, text });
		}
	}

	return lines
		.map((line) => ({
			...line,
			// LRC offset convention: "+" makes lyrics appear sooner, so the
			// tag value is subtracted from every timestamp.
			time: Math.max(0, line.time - offsetMs / 1000),
		}))
		.sort((a, b) => a.time - b.time);
}
