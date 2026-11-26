import {
	acceptWrite,
	captureChanges,
	type Journal,
	type PendingRecord,
	type RemoteRecord,
	receiveRecords,
	type Snapshot,
	sameValue,
} from "./records";

export interface SyncTransport {
	read: () => Promise<RemoteRecord[]>;
	write: (key: string, pending: PendingRecord) => Promise<RemoteRecord>;
}
/** Each account gets its own engine. Cancelling prevents late replies from
 * touching another account's local stores; pending writes stay journalled. */
export class SyncEngine {
	private stopped = false;
	private running = false;
	get isRunning() {
		return this.running;
	}
	get pendingCount() {
		return Object.keys(this.journal.pending).length;
	}
	constructor(
		private journal: Journal,
		private transport: SyncTransport,
		private local: {
			read: () => Snapshot;
			supports?: (key: string) => boolean;
			apply: (data: Snapshot) => void;
			save: (journal: Journal) => void;
		},
	) {
		// Older builds must leave newer cloud fields alone, not convert fields
		// absent from their local adapter into deletion records.
		if (local.supports)
			for (const entries of [
				journal.snapshot,
				journal.pending,
				journal.revisions,
				journal.projection?.baseline ?? {},
			]) {
				for (const key of Object.keys(entries))
					if (!local.supports(key)) delete entries[key];
			}
	}
	stop() {
		this.stopped = true;
	}
	capture() {
		if (this.stopped) return;
		captureChanges(this.journal, this.local.read());
		this.local.save(this.journal);
	}
	private apply(baseline: Snapshot) {
		const next = this.journal.snapshot;
		if (
			Object.keys(baseline).length !== Object.keys(next).length ||
			Object.keys(next).some((key) => !sameValue(baseline[key], next[key]))
		) {
			this.journal.projection = { baseline, applying: true };
			this.local.save(this.journal);
			try {
				this.local.apply(next);
			} catch (error) {
				this.journal.projection = {
					baseline: this.local.read(),
					applying: false,
				};
				this.local.save(this.journal);
				throw error;
			}
			this.journal.snapshot = this.local.read();
		}
		delete this.journal.projection;
		this.local.save(this.journal);
	}
	async sync() {
		if (this.running || this.stopped) return;
		this.running = true;
		try {
			this.capture();
			if (this.journal.projection) this.apply(this.journal.projection.baseline);
			const records = await this.transport.read();
			if (this.stopped) return;
			this.capture();
			receiveRecords(
				this.journal,
				records.filter(
					(record) => !this.local.supports || this.local.supports(record.key),
				),
			);
			this.apply(this.local.read());
			for (const key of Object.keys(this.journal.pending)) {
				if (this.stopped) return;
				const pending = this.journal.pending[key];
				if (!pending) continue;
				const record = await this.transport.write(key, pending);
				if (this.stopped) return;
				this.capture();
				acceptWrite(this.journal, key, pending, record);
				this.apply(this.local.read());
			}
		} finally {
			this.running = false;
		}
	}
}
