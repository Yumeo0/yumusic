export function findKey(node: unknown, key: string): unknown {
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findKey(item, key);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	if (key in record) return record[key];
	for (const value of Object.values(record)) {
		const found = findKey(value, key);
		if (found !== undefined) return found;
	}
	return undefined;
}
