export type RepeatMode = "off" | "all" | "one";

export function normalizeRepeatMode(value: unknown): RepeatMode {
	return value === "all" || value === "one" ? value : "off";
}

/** Manual skips bypass repeat-one; natural endings repeat the current entry. */
export function nextQueueIndex(
	currentIndex: number,
	queueLength: number,
	repeatMode: RepeatMode,
	ended = false,
): number | null {
	if (queueLength === 0) return null;
	if (
		ended &&
		repeatMode === "one" &&
		currentIndex >= 0 &&
		currentIndex < queueLength
	)
		return currentIndex;
	if (currentIndex + 1 < queueLength) return currentIndex + 1;
	return repeatMode === "all" ? 0 : null;
}
