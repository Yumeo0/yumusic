/** Time out one continuous load/seek, never the total age of a playing track. */
export class BufferingWatchdog {
	private startedAt: number | null = null;

	begin(now: number) {
		this.startedAt = now;
	}

	clear() {
		this.startedAt = null;
	}

	expired(now: number, ready: boolean): boolean {
		if (ready) {
			this.clear();
			return false;
		}
		this.startedAt ??= now;
		return now - this.startedAt > 30_000;
	}
}
