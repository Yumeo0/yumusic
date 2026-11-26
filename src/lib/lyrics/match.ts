function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** True when one normalized string contains the other, or they overlap enough. */
export function fieldMatches(
	candidate: string,
	wanted: string,
	minCoverage: number,
): boolean {
	const c = normalize(candidate);
	const w = normalize(wanted);
	if (!c || !w) return false;
	if (c === w || c.includes(w) || w.includes(c)) return true;
	const have = new Set(c.split(" ").filter(Boolean));
	const want = w.split(" ").filter(Boolean);
	if (want.length === 0) return false;
	return (
		want.filter((token) => have.has(token)).length / want.length >= minCoverage
	);
}
