import { describe, expect, test } from "bun:test";
import { SyncEngine, type SyncTransport } from "./engine";
import {
	compareEdits,
	createJournal,
	type Journal,
	type RemoteRecord,
	type Snapshot,
	ZERO_EDIT_ID,
} from "./records";

function server() {
	// Postgres JSONB does not retain the client's object property order.
	const jsonb = (value: RemoteRecord["value"]): RemoteRecord["value"] => {
		if (Array.isArray(value)) return value.map(jsonb);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.sort(([a], [b]) => a.length - b.length || a.localeCompare(b))
					.map(([key, item]) => [key, item === undefined ? null : jsonb(item)]),
			);
		return value;
	};
	const records = new Map<string, RemoteRecord>();
	const transport: SyncTransport = {
		read: async () => structuredClone([...records.values()]),
		write: async (key, pending) => {
			const previous = records.get(key);
			if (
				!previous ||
				((pending.modified_at ?? 0) > 0 &&
					compareEdits(pending, previous) > 0 &&
					(!key.startsWith("trusted/") ||
						previous.revision === pending.revision))
			)
				records.set(key, {
					key,
					value: jsonb(pending.value),
					revision: (previous?.revision ?? 0) + 1,
					modified_at: pending.modified_at ?? 0,
					edit_id: pending.edit_id ?? ZERO_EDIT_ID,
				});
			return structuredClone(records.get(key) as RemoteRecord);
		},
	};
	return { transport, records };
}
function device(
	transport: SyncTransport,
	snapshot: Snapshot,
	saved?: Journal,
	normalize: (data: Snapshot) => Snapshot = (data) => data,
) {
	let local = normalize(structuredClone(snapshot));
	let persisted = saved ?? createJournal(local);
	const engine = new SyncEngine(persisted, transport, {
		read: () => structuredClone(local),
		apply: (next) => {
			local = normalize(structuredClone(next));
		},
		save: (journal) => {
			persisted = structuredClone(journal);
		},
	});
	return {
		engine,
		edit: (next: Snapshot, time?: number) => {
			local = { ...local, ...next };
			engine.capture();
			if (time !== undefined)
				for (const key of Object.keys(next)) {
					const pending = engine.journal.pending[key];
					if (pending) pending.modified_at = time;
				}
		},
		remove: (key: string, time?: number) => {
			delete local[key];
			engine.capture();
			if (time !== undefined && engine.journal.pending[key])
				engine.journal.pending[key].modified_at = time;
		},
		read: () => local,
		saved: () => persisted,
	};
}

describe("account sync", () => {
	test("rich presence syncs to default-off devices and a later disable stays off", async () => {
		const s = server();
		const key = "settings/discordRpc";
		const pc = device(s.transport, { [key]: true });
		const mobile = device(s.transport, {});
		await mobile.engine.sync();
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(mobile.read()[key]).toBe(true);
		pc.remove(key);
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(mobile.read()[key]).toBeUndefined();
		expect(s.records.get(key)?.value).toBeNull();
		const revision = s.records.get(key)?.revision;
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(s.records.get(key)?.revision).toBe(revision);
	});

	test("mobile Sync now downloads the newer PC token instead of uploading an older mobile clear", async () => {
		const s = server();
		const key = "settings/scrobbling";
		const pc = device(s.transport, {
			[key]: { enabled: true, token: "original" },
		});
		const mobile = device(s.transport, {});
		await pc.engine.sync();
		await mobile.engine.sync();
		const time = Date.now();
		mobile.remove(key, time + 10);
		const latest = { enabled: true, token: "new-pc-token" };
		pc.edit({ [key]: latest }, time + 20);
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(mobile.read()[key]).toEqual(latest);
		expect(mobile.saved().pending).toEqual({});
		expect(s.records.get(key)?.revision).toBe(2);
		const editTime = s.records.get(key)?.modified_at;
		await mobile.engine.sync();
		await pc.engine.sync();
		expect(s.records.get(key)?.modified_at).toBe(editTime);
		expect(s.records.get(key)?.revision).toBe(2);
	});

	test("the newest mobile settings win even when an older offline PC edit syncs afterward", async () => {
		const s = server();
		const key = "settings/scrobbling";
		const pc = device(s.transport, {
			[key]: { enabled: true, token: "original" },
		});
		const mobile = device(s.transport, {});
		await pc.engine.sync();
		await mobile.engine.sync();
		const time = Date.now();
		pc.edit({ [key]: { enabled: true, token: "older-pc-token" } }, time + 10);
		const latest = { enabled: true, token: "newer-mobile-token" };
		mobile.edit({ [key]: latest }, time + 20);
		await mobile.engine.sync();
		await pc.engine.sync();
		expect(pc.read()[key]).toEqual(latest);
		expect(s.records.get(key)?.value).toEqual(latest);
		expect(s.records.get(key)?.revision).toBe(2);
	});
	test("unrecognized cloud fields and old queued echoes are left untouched", async () => {
		const s = server();
		const key = "settings/future-option";
		s.records.set(key, { key, value: "future configuration", revision: 7 });
		const journal = createJournal({ [key]: "old queued value" });
		const engine = new SyncEngine(journal, s.transport, {
			read: () => ({}),
			apply: () => undefined,
			save: () => undefined,
			supports: (candidate) => candidate === "settings/known-option",
		});
		await engine.sync();
		await engine.sync();
		expect(s.records.get(key)?.value).toBe("future configuration");
		expect(s.records.get(key)?.revision).toBe(7);
		expect(journal.pending).toEqual({});
		expect(journal.snapshot).toEqual({});
	});
	test("entering a token replaces an older cleared cloud configuration instead of erasing the input", async () => {
		const s = server();
		const key = "settings/scrobbling";
		s.records.set(key, { key, value: null, revision: 112 });
		const pc = device(s.transport, {});
		const config = { enabled: true, token: "new-token" };
		pc.edit({ [key]: config });
		await pc.engine.sync();
		expect(pc.read()[key]).toEqual(config);
		expect(s.records.get(key)?.value).toEqual(config);
		expect(s.records.get(key)?.revision).toBe(113);
	});

	test("a genuinely newer cloud clear wins over an earlier in-flight token edit", async () => {
		const s = server();
		const key = "settings/scrobbling";
		let race = false;
		const transport = {
			...s.transport,
			write: async (
				recordKey: string,
				pending: Parameters<SyncTransport["write"]>[1],
			) => {
				if (race && recordKey === key) {
					race = false;
					const previous = s.records.get(key);
					s.records.set(key, {
						key,
						value: null,
						revision: (previous?.revision ?? 0) + 1,
						modified_at: (pending.modified_at ?? 0) + 1,
						edit_id: crypto.randomUUID(),
					});
				}
				return s.transport.write(recordKey, pending);
			},
		};
		const pc = device(transport, {
			[key]: { enabled: true, token: "old-token" },
		});
		await pc.engine.sync();
		const config = { enabled: true, token: "new-token" };
		pc.edit({ [key]: config });
		race = true;
		await pc.engine.sync();
		expect(pc.read()[key]).toBeUndefined();
		expect(pc.saved().pending).toEqual({});
		await pc.engine.sync();
		expect(s.records.get(key)?.value).toBeNull();
		expect(pc.saved().pending).toEqual({});
	});
	test("alternating devices do not echo JSONB property-order changes back to the server", async () => {
		const s = server();
		const localOrder = (data: Snapshot): Snapshot => {
			const value = data["settings/scrobbling"];
			return value && typeof value === "object" && !Array.isArray(value)
				? {
						...data,
						"settings/scrobbling": {
							enabled: value.enabled,
							token: value.token,
						},
					}
				: data;
		};
		const pc = device(
			s.transport,
			{ "settings/scrobbling": { enabled: true, token: "test-token" } },
			undefined,
			localOrder,
		);
		const mobile = device(s.transport, {}, undefined, localOrder);
		await pc.engine.sync();
		await mobile.engine.sync();
		for (let i = 0; i < 5; i++) {
			await pc.engine.sync();
			await mobile.engine.sync();
		}
		expect(s.records.get("settings/scrobbling")?.revision).toBe(1);
		expect(pc.saved().pending).toEqual({});
		expect(mobile.saved().pending).toEqual({});
		pc.edit({ "settings/scrobbling": { enabled: false, token: "test-token" } });
		await pc.engine.sync();
		await mobile.engine.sync();
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(s.records.get("settings/scrobbling")?.revision).toBe(2);
		expect(mobile.read()["settings/scrobbling"]).toEqual({
			enabled: false,
			token: "test-token",
		});
	});
	test("an unconfigured mobile client cannot erase the PC scrobble configuration on first sync", async () => {
		const s = server();
		const mobile = device(s.transport, {});
		await mobile.engine.sync();
		const config = { enabled: true, token: "test-token" };
		const pc = device(s.transport, { "settings/scrobbling": config });
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(mobile.read()["settings/scrobbling"]).toEqual(config);
		pc.remove("settings/scrobbling");
		await pc.engine.sync();
		await mobile.engine.sync();
		expect(mobile.read()["settings/scrobbling"]).toBeUndefined();
		expect(s.records.get("settings/scrobbling")?.value).toBeNull();
	});
	test("independent offline edits merge and a fresh device uses cloud preferences", async () => {
		const s = server();
		const a = device(s.transport, {
			"settings/cleanTitles": true,
			"settings/crossfade": true,
		});
		await a.engine.sync();
		const b = device(s.transport, {
			"settings/cleanTitles": false,
			"settings/crossfade": false,
		});
		await b.engine.sync();
		expect(b.read()).toEqual(a.read());
		a.edit({ "settings/cleanTitles": false });
		b.edit({ "settings/crossfade": false });
		await a.engine.sync();
		await b.engine.sync();
		await a.engine.sync();
		expect(a.read()).toEqual({
			"settings/cleanTitles": false,
			"settings/crossfade": false,
		});
	});

	test("a stale offline device cannot resurrect a removed trusted device", async () => {
		const s = server();
		const key = `trusted/${"a".repeat(64)}`;
		const a = device(s.transport, { [key]: "Alice" });
		await a.engine.sync();
		const b = device(s.transport, {});
		await b.engine.sync();
		b.edit({ [key]: "Alice renamed" });
		a.remove(key);
		await a.engine.sync();
		await b.engine.sync();
		expect(b.read()[key]).toBeUndefined();
		expect(s.records.get(key)?.value).toBeNull();
		expect(s.records.get(key)?.revision).toBe(2);
	});

	test("failed uploads survive restart and an acknowledged-late write is idempotent", async () => {
		const s = server();
		const broken: SyncTransport = {
			...s.transport,
			write: async (key, pending) => {
				await s.transport.write(key, pending);
				throw new Error("connection lost after commit");
			},
		};
		const a = device(broken, { "settings/cleanTitles": false });
		await expect(a.engine.sync()).rejects.toThrow("connection lost");
		expect(Object.keys(a.saved().pending)).toHaveLength(1);
		const restart = device(s.transport, a.read(), a.saved());
		await restart.engine.sync();
		expect(restart.saved().pending).toEqual({});
		expect(s.records.get("settings/cleanTitles")?.revision).toBe(1);
	});

	test("edits made during a network request stay pending for the next sync", async () => {
		const s = server();
		let edit: () => void = () => undefined;
		const transport = {
			...s.transport,
			write: async (
				key: string,
				pending: Parameters<SyncTransport["write"]>[1],
			) => {
				edit();
				edit = () => undefined;
				return s.transport.write(key, pending);
			},
		};
		const a = device(transport, { "settings/cleanTitles": true });
		edit = () => a.edit({ "settings/cleanTitles": false });
		await a.engine.sync();
		expect(a.read()["settings/cleanTitles"]).toBe(false);
		expect(a.saved().pending["settings/cleanTitles"]?.revision).toBe(1);
		await a.engine.sync();
		expect(s.records.get("settings/cleanTitles")?.value).toBe(false);
		expect(a.saved().pending).toEqual({});
	});

	test("switching accounts stops a late reply from touching local data", async () => {
		let respond: (records: RemoteRecord[]) => void = () => undefined;
		const a = device(
			{
				read: () =>
					new Promise((resolve) => {
						respond = resolve;
					}),
				write: async () => {
					throw new Error("unexpected write");
				},
			},
			{},
		);
		const request = a.engine.sync();
		a.engine.stop();
		respond([{ key: "trusted/private", value: "other account", revision: 1 }]);
		await request;
		expect(a.read()).toEqual({});
	});
});
