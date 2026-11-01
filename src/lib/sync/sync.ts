import type { Session } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";
import { accountDataClient, supabase } from "./client";
import { SyncEngine } from "./engine";
import { SYNC_DATA_CHANGED } from "./events";
import {
	applyLocalData,
	migrateRichPresenceBackup,
	migrateScrobbleBackup,
	readLocalData,
	supportsSyncKey,
} from "./local-data";
import { finishBrowserSignIn } from "./oauth";
import {
	createJournal,
	type Journal,
	type RemoteRecord,
	type Snapshot,
	ZERO_EDIT_ID,
} from "./records";
import {
	getYouTubeSyncAccount,
	matchesYouTubeAccount,
	YOUTUBE_ACCOUNT_CHANGED,
	type YouTubeSyncAccount,
} from "./youtube-account";

interface SyncState {
	email: string | null;
	status: "signed-out" | "syncing" | "synced" | "error";
	error: string | null;
	lastSynced: number | null;
	pending: number;
	youtubeStatus: YouTubeSyncAccount["status"];
	youtubeEmail: string | null;
}
let state: SyncState = {
	email: null,
	status: "signed-out",
	error: null,
	lastSynced: null,
	pending: 0,
	youtubeStatus: "checking",
	youtubeEmail: null,
};
const listeners = new Set<() => void>();
function update(patch: Partial<SyncState>) {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}
export const useCloudSync = () =>
	useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => state,
	);

const OWNER_KEY = "yumusic:sync:owner";
const GUEST_KEY = "yumusic:sync:guest";
const journalKey = (owner: string) => `yumusic:sync:journal:${owner}`;
let owner: string | null = null;
let engine: SyncEngine | null = null;
let applying = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function apply(snapshot: Snapshot) {
	applying = true;
	try {
		applyLocalData(snapshot);
	} finally {
		applying = false;
	}
}

function changeAccount(session: Session | null) {
	const nextOwner = session?.user.id ?? null;
	if (nextOwner === owner && localStorage.getItem(OWNER_KEY) === nextOwner)
		return;
	engine?.capture();
	engine?.stop();
	window.dispatchEvent(new Event("yumusic:sync-account-changed"));
	engine = null;
	owner = null;
	// Restore local preferences when leaving an account. A different account
	// never inherits the previous account's private trust or pinned lists.
	const storedOwner = localStorage.getItem(OWNER_KEY);
	if (storedOwner && storedOwner !== nextOwner) {
		const guest = localStorage.getItem(GUEST_KEY);
		if (!guest)
			throw new Error(
				"The device's local settings backup is missing. Sync is paused.",
			);
		apply(JSON.parse(guest));
		localStorage.removeItem(OWNER_KEY);
	}
	if (!session || !nextOwner) {
		update({
			email: null,
			status: "signed-out",
			error: null,
			pending: 0,
			lastSynced: null,
		});
		return;
	}
	if (!storedOwner || storedOwner !== nextOwner)
		localStorage.setItem(GUEST_KEY, JSON.stringify(readLocalData()));
	const raw = localStorage.getItem(journalKey(nextOwner));
	let journal: Journal;
	if (raw) {
		journal = JSON.parse(raw);
		if (
			journal.version !== 1 ||
			!journal.snapshot ||
			!journal.revisions ||
			!journal.pending
		)
			throw new Error(
				"The saved sync journal is invalid. Sync is paused to protect your data.",
			);
		if (storedOwner !== nextOwner) apply(journal.snapshot);
	} else journal = createJournal(readLocalData());
	localStorage.setItem(journalKey(nextOwner), JSON.stringify(journal));
	localStorage.setItem(OWNER_KEY, nextOwner);
	owner = nextOwner;
	const dataClient = accountDataClient(nextOwner);
	engine = new SyncEngine(
		journal,
		{
			read: async () => {
				const records: RemoteRecord[] = [];
				for (let offset = 0; ; offset += 500) {
					const { data, error } = await dataClient
						.from("sync_records")
						.select("key,value,revision,modified_at,edit_id")
						.eq("user_id", nextOwner)
						.order("key")
						.range(offset, offset + 499);
					if (error) throw error;
					records.push(...data);
					if (data.length < 500) return records;
				}
			},
			write: async (key, pending) => {
				const { data, error } = await dataClient.rpc("write_sync_record", {
					record_key: key,
					record_value: pending.value,
					expected_revision: pending.revision,
					record_modified_at: pending.modified_at ?? 0,
					record_edit_id: pending.edit_id ?? ZERO_EDIT_ID,
				});
				if (error) throw error;
				if (data?.[0]) return data[0];
				// A newer value (including a deletion) wins a revision conflict.
				const result = await dataClient
					.from("sync_records")
					.select("key,value,revision,modified_at,edit_id")
					.eq("user_id", nextOwner)
					.eq("key", key)
					.single();
				if (result.error) throw result.error;
				return result.data;
			},
		},
		{
			read: readLocalData,
			supports: supportsSyncKey,
			apply,
			save: (value) =>
				localStorage.setItem(journalKey(nextOwner), JSON.stringify(value)),
		},
	);
	update({
		email: session.user.email ?? "Google account",
		status: "syncing",
		error: null,
		lastSynced: null,
	});
	scheduleSync(0);
}

export async function syncNow(options: { background?: boolean } = {}) {
	const current = engine;
	if (!current || current.isRunning) return;
	if (!options.background || Object.keys(current.journal.pending).length > 0)
		update({ status: "syncing", error: null });
	try {
		await current.sync();
		if (engine !== current) return;
		const pending = Object.keys(current.journal.pending).length;
		update({ status: "synced", error: null, lastSynced: Date.now(), pending });
		if (pending) scheduleSync(500);
	} catch (error) {
		if (engine !== current) return;
		update({
			status: "error",
			error:
				error instanceof Error
					? error.message
					: "Could not sync. Your changes are saved on this device.",
			pending: Object.keys(current.journal.pending).length,
		});
	}
}
function scheduleSync(delay = 750) {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		void syncNow({ background: true });
	}, delay);
}

export async function signOutOfSync() {
	engine?.capture();
	await (
		await import("../listen-together/account-identity")
	).unlinkRoomIdentity();
	const { error } = await supabase.auth.signOut({ scope: "local" });
	if (error) throw error;
	changeAccount(null);
}

export function startCloudSync() {
	try {
		migrateScrobbleBackup();
		migrateRichPresenceBackup();
	} catch {
		update({
			status: "error",
			error:
				"Could not preserve your local settings. Free some device storage and restart to resume sync.",
		});
		return () => undefined;
	}
	let stopped = false;
	let session: Session | null = null;
	const reconcile = () => {
		if (stopped) return;
		const expected = getYouTubeSyncAccount();
		update({
			youtubeStatus: expected.status,
			youtubeEmail: expected.status === "ready" ? expected.email : null,
		});
		try {
			if (expected.status === "checking" || expected.status === "unavailable") {
				engine?.capture();
				engine?.stop();
				engine = null;
				owner = null;
				update({
					email: null,
					status: "signed-out",
					error:
						expected.status === "unavailable"
							? "Sign in to YouTube again so sync can identify your Google account."
							: null,
				});
				return;
			}
			if (
				expected.status === "signed-out" ||
				!session ||
				!matchesYouTubeAccount(session.user)
			) {
				changeAccount(null);
				update({
					email: null,
					status: "signed-out",
					error:
						expected.status === "ready" && session
							? `Enable sync with your YouTube Google account (${expected.email}).`
							: null,
				});
				return;
			}
			changeAccount(session);
		} catch (error) {
			update({ status: "error", error: String(error) });
		}
	};
	window.addEventListener(YOUTUBE_ACCOUNT_CHANGED, reconcile);
	const onChange = () => {
		if (applying || !engine) return;
		try {
			engine.capture();
			update({ pending: Object.keys(engine.journal.pending).length });
			scheduleSync();
		} catch {
			update({
				status: "error",
				error: "Device storage is full. Free some space to save sync changes.",
			});
		}
	};
	const onStorage = (event: StorageEvent) => {
		if (
			!event.key ||
			event.key.startsWith("yumusic:sync:") ||
			event.key.startsWith("yumusic-sync-auth")
		)
			return;
		onChange();
	};
	const onResume = () => {
		if (document.visibilityState === "visible") scheduleSync(0);
	};
	window.addEventListener(SYNC_DATA_CHANGED, onChange);
	window.addEventListener("yumusic:settings-changed", onChange);
	window.addEventListener("yumusic:pinned-changed", onChange);
	window.addEventListener("storage", onStorage);
	window.addEventListener("online", onResume);
	document.addEventListener("visibilitychange", onResume);
	const interval = setInterval(() => {
		if (document.visibilityState === "visible")
			void syncNow({ background: true });
	}, 30_000);
	const {
		data: { subscription },
	} = supabase.auth.onAuthStateChange((_event, nextSession) => {
		session = nextSession;
		// Never await another Supabase call while inside the Auth callback.
		setTimeout(() => {
			reconcile();
		}, 0);
	});
	void finishBrowserSignIn().catch((error) =>
		update({ status: "error", error: String(error) }),
	);
	return () => {
		stopped = true;
		subscription.unsubscribe();
		engine?.stop();
		engine = null;
		owner = null;
		if (timer) clearTimeout(timer);
		clearInterval(interval);
		window.removeEventListener(SYNC_DATA_CHANGED, onChange);
		window.removeEventListener(YOUTUBE_ACCOUNT_CHANGED, reconcile);
		window.removeEventListener("yumusic:settings-changed", onChange);
		window.removeEventListener("yumusic:pinned-changed", onChange);
		window.removeEventListener("storage", onStorage);
		window.removeEventListener("online", onResume);
		document.removeEventListener("visibilitychange", onResume);
	};
}
