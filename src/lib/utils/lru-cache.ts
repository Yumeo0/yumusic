/** A session cache with a fixed entry budget; reads keep useful entries hot. */
export class LruCache<K, V> extends Map<K, V> {
	constructor(private readonly limit: number) {
		super();
		if (!Number.isInteger(limit) || limit < 1) {
			throw new RangeError("Cache limit must be a positive integer");
		}
	}

	override get(key: K): V | undefined {
		const value = super.get(key);
		if (super.has(key)) {
			super.delete(key);
			super.set(key, value as V);
		}
		return value;
	}

	override set(key: K, value: V): this {
		super.delete(key);
		super.set(key, value);
		while (this.size > this.limit) {
			const oldest = this.keys().next();
			if (!oldest.done) super.delete(oldest.value);
		}
		return this;
	}
}
