import { expect, test } from "bun:test";
import {
	captureChanges,
	createJournal,
	receiveRecords,
	sameValue,
} from "./records";

test("syncing does not refresh edit times, and a backwards clock stays monotonic", () => {
	const journal = createJournal({});
	captureChanges(journal, { "settings/value": 1 }, 1000);
	expect(journal.pending["settings/value"].modified_at).toBe(1000);
	captureChanges(journal, { "settings/value": 1 }, 9000);
	expect(journal.pending["settings/value"].modified_at).toBe(1000);
	captureChanges(journal, { "settings/value": 2 }, 500);
	expect(journal.pending["settings/value"].modified_at).toBe(1001);
});

test("queued edits from builds without edit times cannot overwrite newer cloud data", () => {
	const key = "settings/scrobbling";
	const journal = createJournal({});
	journal.snapshot[key] = null;
	journal.pending[key] = { value: null, revision: 1, origin: "edit" };
	receiveRecords(journal, [
		{
			key,
			value: { enabled: true, token: "new-token" },
			revision: 2,
			modified_at: 2000,
			edit_id: "00000000-0000-0000-0000-000000000001",
		},
	]);
	expect(journal.pending).toEqual({});
	expect(journal.snapshot).toEqual({
		[key]: { enabled: true, token: "new-token" },
	});
});

test("JSONB object ordering does not turn nested configurations into edits", () => {
	expect(
		sameValue(
			{ enabled: true, token: "example" },
			{ token: "example", enabled: true },
		),
	).toBe(true);
	expect(
		sameValue(
			{ profile: { username: "Friend", avatar: null }, source: "guest" },
			{ source: "guest", profile: { avatar: null, username: "Friend" } },
		),
	).toBe(true);
	expect(sameValue({ a: undefined }, {})).toBe(true);
});

test("real edits, array reordering and deletions still sync", () => {
	expect(sameValue(["first", "second"], ["second", "first"])).toBe(false);
	expect(
		sameValue(
			{ enabled: true, token: "before" },
			{ token: "after", enabled: true },
		),
	).toBe(false);
	expect(sameValue({ enabled: true }, { enabled: false })).toBe(false);
	expect(sameValue({ a: null }, {})).toBe(false);
	expect(sameValue(undefined, null)).toBe(false);
});
