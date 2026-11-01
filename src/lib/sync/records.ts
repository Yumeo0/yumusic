import type { Json } from "./database.types";
export type SyncValue = Json;
export type Snapshot = Record<string, SyncValue>;
export interface EditVersion {
	modified_at?: number;
	edit_id?: string;
}
export const ZERO_EDIT_ID = "00000000-0000-0000-0000-000000000000";
export function compareEdits(a: EditVersion, b: EditVersion): number {
	const time = (a.modified_at ?? 0) - (b.modified_at ?? 0);
	if (time !== 0) return Math.sign(time);
	const left = a.edit_id ?? ZERO_EDIT_ID;
	const right = b.edit_id ?? ZERO_EDIT_ID;
	return left === right ? 0 : left > right ? 1 : -1;
}
export interface RemoteRecord extends EditVersion {
	key: string;
	value: SyncValue;
	revision: number;
}
export interface PendingRecord extends EditVersion {
	value: SyncValue;
	revision: number;
	origin?: "initial" | "edit";
}
export interface Journal {
	version: 1;
	snapshot: Snapshot;
	revisions: Record<string, number>;
	pending: Record<string, PendingRecord>;
	clock?: number;
}
/** JSONB reorders object keys. Their order is not an edit; array order is. */
export function sameValue(
	a: SyncValue | undefined,
	b: SyncValue | undefined,
): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, i) => sameValue(value, b[i]))
		);
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
	const aKeys = Object.keys(a).filter((key) => a[key] !== undefined);
	const bKeys = Object.keys(b).filter((key) => b[key] !== undefined);
	return (
		aKeys.length === bKeys.length &&
		aKeys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
	);
}

export function createJournal(snapshot: Snapshot): Journal {
	return {
		version: 1,
		snapshot: { ...snapshot },
		revisions: {},
		clock: 0,
		pending: Object.fromEntries(
			Object.entries(snapshot).map(([key, value]) => [
				key,
				{
					value,
					revision: 0,
					origin: "initial" as const,
					modified_at: 0,
					edit_id: crypto.randomUUID(),
				},
			]),
		),
	};
}

/** Record only actual edits; a deleted list entry stays a tombstone remotely. */
export function captureChanges(
	journal: Journal,
	snapshot: Snapshot,
	editedAt = Date.now(),
) {
	for (const key of new Set([
		...Object.keys(journal.snapshot),
		...Object.keys(snapshot),
	])) {
		if (sameValue(journal.snapshot[key], snapshot[key])) continue;
		journal.clock = Math.max(editedAt, (journal.clock ?? 0) + 1);
		journal.pending[key] = {
			value: snapshot[key] ?? null,
			revision: journal.pending[key]?.revision ?? journal.revisions[key] ?? 0,
			origin: "edit",
			modified_at: journal.clock,
			edit_id: crypto.randomUUID(),
		};
	}
	journal.snapshot = { ...snapshot };
}

/** A pull never changes an edit's time. Newer cloud edits replace older pending
 * changes; newer local edits keep their original version until uploaded. */
export function receiveRecords(journal: Journal, records: RemoteRecord[]) {
	for (const record of records) {
		journal.clock = Math.max(journal.clock ?? 0, record.modified_at ?? 0);
		journal.revisions[record.key] = record.revision;
		const pending = journal.pending[record.key];
		if (
			pending &&
			pending.origin !== "initial" &&
			compareEdits(pending, record) > 0 &&
			(!record.key.startsWith("trusted/") ||
				pending.revision === record.revision)
		)
			continue;
		delete journal.pending[record.key];
		if (record.value === null) delete journal.snapshot[record.key];
		else journal.snapshot[record.key] = record.value;
	}
}

/** The database returns the winning edit, whether or not our write won. */
export function acceptWrite(
	journal: Journal,
	key: string,
	sent: PendingRecord,
	record: RemoteRecord,
) {
	journal.clock = Math.max(journal.clock ?? 0, record.modified_at ?? 0);
	journal.revisions[key] = record.revision;
	const pending = journal.pending[key];
	if (
		pending &&
		pending.origin !== "initial" &&
		compareEdits(pending, record) > 0 &&
		(!key.startsWith("trusted/") || compareEdits(sent, record) === 0)
	) {
		pending.revision = record.revision;
		return;
	}
	delete journal.pending[key];
	if (record.value === null) delete journal.snapshot[key];
	else journal.snapshot[key] = record.value;
}
