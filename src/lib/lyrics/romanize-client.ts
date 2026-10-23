/** Dictionaries live in a disposable worker, never in the app's permanent heap. */
export class RomanizeClient {
	private worker: Worker | null = null;
	private nextId = 0;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private pending = new Map<number, (lines: string[]) => void>();

	constructor(
		private readonly createWorker: () => Worker,
		private readonly idleMs = 30_000,
	) {}

	private dispose() {
		clearTimeout(this.idleTimer);
		this.worker?.terminate();
		this.worker = null;
		for (const finish of [...this.pending.values()]) finish([]);
		clearTimeout(this.idleTimer);
	}

	request(lines: string[], signal?: AbortSignal): Promise<string[]> {
		if (signal?.aborted) return Promise.resolve([]);
		clearTimeout(this.idleTimer);
		try {
			if (!this.worker) {
				this.worker = this.createWorker();
				this.worker.onmessage = (
					event: MessageEvent<{ id: number; lines: string[] }>,
				) => {
					this.pending.get(event.data.id)?.(event.data.lines);
				};
				this.worker.onerror = () => this.dispose();
				this.worker.onmessageerror = () => this.dispose();
			}
		} catch {
			return Promise.resolve([]);
		}
		const id = ++this.nextId;
		return new Promise((resolve) => {
			const abort = () => {
				finish([]);
				if (this.pending.size === 0) this.dispose();
			};
			const timeout = setTimeout(() => this.dispose(), 120_000);
			const finish = (result: string[]) => {
				if (!this.pending.delete(id)) return;
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
				resolve(result);
				if (this.pending.size === 0) {
					this.idleTimer = setTimeout(() => this.dispose(), this.idleMs);
				}
			};
			this.pending.set(id, finish);
			signal?.addEventListener("abort", abort, { once: true });
			try {
				this.worker?.postMessage({ id, lines });
			} catch {
				this.dispose();
			}
		});
	}
}
