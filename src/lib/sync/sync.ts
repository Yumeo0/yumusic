import type { Session } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";
import { AUTH_STORAGE_KEY, supabase, watchSyncAccount } from "./client";
import { SyncEngine } from "./engine";
import { SYNC_ACCOUNT_CHANGED, SYNC_DATA_CHANGED } from "./events";
import {
	applyLocalData,
	GUEST_BACKUP_KEY,
	migrateGuestBackup,
	readLocalData,
	supportsSyncKey,
} from "./local-data";
import { authorizeWithGoogle, finishBrowserSignIn } from "./oauth";
import { createJournal, type Journal, type Snapshot } from "./records";
import { syncRepository } from "./repository";
import {
	getYouTubeSyncAccount,
	matchesYouTubeAccount,
	type YouTubeSyncAccount,
	youtubeSyncEmail,
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
const GUEST_RESTORE_KEY = "yumusic:sync:guest-restore";
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

function archiveAccount() {
	const previous = engine;
	const previousOwner = owner;
	engine = null;
	owner = null;
	if (timer) clearTimeout(timer);
	timer = null;
	if (!previous) return;
	try {
		if (
			localStorage.getItem(OWNER_KEY) === previousOwner &&
			localStorage.getItem(GUEST_RESTORE_KEY) === null
		)
			previous.capture();
	} finally {
		previous.stop();
	}
}

function changeAccount(session: Session | null) {
	const nextOwner = session?.user.id ?? null;
	const storedOwner = localStorage.getItem(OWNER_KEY);
	const restoringGuest = localStorage.getItem(GUEST_RESTORE_KEY) !== null;
	if (nextOwner === owner && storedOwner === nextOwner && !restoringGuest)
		return;
	try {
		archiveAccount();
	} finally {
		window.dispatchEvent(new Event(SYNC_ACCOUNT_CHANGED));
	}
	// Restore local preferences when leaving an account. A different account
	// never inherits the previous account's private trust or pinned lists.
	if (restoringGuest || (storedOwner && storedOwner !== nextOwner)) {
		const guest = localStorage.getItem(GUEST_BACKUP_KEY);
		if (!guest)
			throw new Error(
				"The device's local settings backup is missing. Sync is paused.",
			);
		if (!restoringGuest) localStorage.setItem(GUEST_RESTORE_KEY, "1");
		apply(JSON.parse(guest));
		localStorage.removeItem(OWNER_KEY);
		localStorage.removeItem(GUEST_RESTORE_KEY);
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
	const entering = restoringGuest || storedOwner !== nextOwner;
	const guest = entering ? readLocalData() : null;
	if (guest) localStorage.setItem(GUEST_BACKUP_KEY, JSON.stringify(guest));
	const raw = localStorage.getItem(journalKey(nextOwner));
	let journal: Journal;
	if (raw) {
		journal = JSON.parse(raw);
		if (
			journal.version !== 1 ||
			!journal.snapshot ||
			!journal.revisions ||
			!journal.pending ||
			(journal.projection &&
				(!journal.projection.baseline ||
					typeof journal.projection.applying !== "boolean"))
		)
			throw new Error(
				"The saved sync journal is invalid. Sync is paused to protect your data.",
			);
		if (guest) journal.projection = { baseline: guest, applying: false };
	} else journal = createJournal(readLocalData());
	localStorage.setItem(journalKey(nextOwner), JSON.stringify(journal));
	localStorage.setItem(OWNER_KEY, nextOwner);
	owner = nextOwner;
	engine = new SyncEngine(journal, syncRepository(nextOwner), {
		read: readLocalData,
		supports: supportsSyncKey,
		apply,
		save: (value) =>
			localStorage.setItem(journalKey(nextOwner), JSON.stringify(value)),
	});
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
	if (!options.background || current.pendingCount > 0)
		update({ status: "syncing", error: null });
	try {
		await current.sync();
		if (engine !== current) return;
		const pending = current.pendingCount;
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
			pending: current.pendingCount,
		});
	}
}
function scheduleSync(delay = 750) {
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		void syncNow({ background: true });
	}, delay);
}

export async function signInWithGoogle() {
	const email = youtubeSyncEmail();
	const {
		data: { session },
	} = await supabase.auth.getSession();
	if (session && matchesYouTubeAccount(session.user)) return;
	if (session) await signOutOfSync();
	await authorizeWithGoogle(email);
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
		migrateGuestBackup();
	} catch {
		update({
			status: "error",
			error:
				"Could not preserve your local settings. Free some device storage and restart to resume sync.",
		});
		return () => undefined;
	}
	const stopAccountWatch = watchSyncAccount((session) => {
		const expected = getYouTubeSyncAccount();
		update({
			youtubeStatus: expected.status,
			youtubeEmail: expected.status === "ready" ? expected.email : null,
		});
		try {
			if (expected.status === "checking" || expected.status === "unavailable") {
				archiveAccount();
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
	});
	const onChange = () => {
		if (applying || !engine) return;
		try {
			engine.capture();
			update({ pending: engine.pendingCount });
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
			event.key.startsWith(AUTH_STORAGE_KEY)
		)
			return;
		onChange();
	};
	const onResume = () => {
		if (document.visibilityState === "visible") scheduleSync(0);
	};
	window.addEventListener(SYNC_DATA_CHANGED, onChange);
	window.addEventListener("storage", onStorage);
	window.addEventListener("online", onResume);
	document.addEventListener("visibilitychange", onResume);
	const interval = setInterval(() => {
		if (document.visibilityState === "visible")
			void syncNow({ background: true });
	}, 30_000);
	void finishBrowserSignIn().catch((error) =>
		update({ status: "error", error: String(error) }),
	);
	return () => {
		stopAccountWatch();
		engine?.stop();
		engine = null;
		owner = null;
		if (timer) clearTimeout(timer);
		clearInterval(interval);
		window.removeEventListener(SYNC_DATA_CHANGED, onChange);
		window.removeEventListener("storage", onStorage);
		window.removeEventListener("online", onResume);
		document.removeEventListener("visibilitychange", onResume);
	};
}
