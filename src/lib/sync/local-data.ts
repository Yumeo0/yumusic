import {
	readSavedGuestPermissions,
	replaceSavedGuestPermissions,
	validPermissions,
} from "../listen-together/guest-permissions";
import {
	joinSettingsStorage,
	validPolicy,
	validTrustKey,
} from "../listen-together/join-settings";
import {
	readSavedRoomProfile,
	replaceSavedRoomProfile,
	validSavedRoomProfile,
} from "../listen-together/profile";
import { isRepeatMode } from "../player/repeat";
import { getPinnedPlaylists, replacePinnedPlaylists } from "../stores/pinned";
import {
	CROSSFADE_MAX_SECONDS,
	CROSSFADE_MIN_SECONDS,
	getSettings,
	type Settings,
	updateSettings,
} from "../stores/settings";
import { ROOM_SETTINGS_RELOADED } from "./events";
import type { Snapshot, SyncValue } from "./records";

// Explicit preference allowlist. ListenBrainz configuration is synced as one
// record below; app login credentials and device-specific options stay local.
const isBoolean = (value: SyncValue) => typeof value === "boolean";

const syncedSettings = {
	discordRpc: isBoolean,
	romanizeLyrics: isBoolean,
	titleMode: (value) =>
		value === "both" || value === "original" || value === "translation",
	cleanTitles: isBoolean,
	lyricsProviderOrder: (value) =>
		Array.isArray(value) &&
		value.length <= 10 &&
		value.every((id) => typeof id === "string"),
	preferSyncedLyrics: isBoolean,
	lrclibLooseMatch: isBoolean,
	hiddenHomeSections: (value) =>
		Array.isArray(value) &&
		value.length <= 500 &&
		value.every((title) => typeof title === "string" && title.length <= 500),
	autoplay: isBoolean,
	repeatMode: isRepeatMode,
	crossfade: isBoolean,
	crossfadeSeconds: (value) =>
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= CROSSFADE_MIN_SECONDS &&
		value <= CROSSFADE_MAX_SECONDS,
	watchHistory: isBoolean,
} satisfies Partial<Record<keyof Settings, (value: SyncValue) => boolean>>;

const settingKeys = Object.keys(
	syncedSettings,
) as (keyof typeof syncedSettings)[];
export const GUEST_BACKUP_KEY = "yumusic:sync:guest";

export const SCROBBLE_SYNC_KEY = "settings/scrobbling";
export function supportsSyncKey(key: string) {
	return (
		key === SCROBBLE_SYNC_KEY ||
		settingKeys.some((setting) => key === `settings/${setting}`) ||
		key.startsWith("pinned/") ||
		(key.startsWith("trusted/") && validTrustKey(key.slice(8))) ||
		["joinPolicy", "guestPermissions", "roomProfile"].includes(key)
	);
}
function validScrobbling(
	value: SyncValue,
): value is { enabled: boolean; token: string } {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		typeof value.enabled === "boolean" &&
		typeof value.token === "string" &&
		value.token.length <= 256 &&
		!Array.from(value.token).some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	);
}

/** Pre-sync backups may predate synced scrobbling and rich presence. */
export function migrateGuestBackup() {
	for (const [name, key] of [
		["scrobbling", SCROBBLE_SYNC_KEY],
		["rich-presence", "settings/discordRpc"],
	]) {
		const marker = `yumusic:sync:${name}-migrated:v1`;
		if (localStorage.getItem(marker)) continue;
		const raw = localStorage.getItem(GUEST_BACKUP_KEY);
		if (raw) {
			const guest = JSON.parse(raw) as Snapshot;
			const value = readLocalData()[key];
			if (guest[key] === undefined && value !== undefined) {
				guest[key] = value;
				localStorage.setItem(GUEST_BACKUP_KEY, JSON.stringify(guest));
			}
		}
		localStorage.setItem(marker, "1");
	}
}

export function readLocalData(): Snapshot {
	const snapshot: Snapshot = {};
	const settings = getSettings();
	for (const key of settingKeys) {
		// Default-off devices publish no rich-presence value. Disabling a
		// previously synced value produces a timestamped deletion instead.
		if (key === "discordRpc" && !settings.discordRpc) continue;
		snapshot[`settings/${key}`] = settings[key];
	}
	const scrobbling = {
		enabled: settings.listenbrainz,
		token: settings.listenbrainzToken,
	};
	// Fresh-device defaults must not replace a configured PC's settings.
	// Clearing both fields removes the record, preserving a cloud tombstone.
	if (validScrobbling(scrobbling) && (scrobbling.enabled || scrobbling.token))
		snapshot[SCROBBLE_SYNC_KEY] = scrobbling;
	for (const pinned of getPinnedPlaylists())
		snapshot[`pinned/${encodeURIComponent(pinned.id)}`] = { ...pinned };
	const joins = joinSettingsStorage.read();
	snapshot.joinPolicy = joins.policy;
	for (const person of joins.people)
		snapshot[`trusted/${person.fingerprint}`] = person.username;
	const permissions = readSavedGuestPermissions();
	if (permissions) snapshot.guestPermissions = permissions;
	const profile = readSavedRoomProfile();
	if (profile)
		snapshot.roomProfile = {
			source: profile.source,
			profile: { ...profile.profile },
		};
	return snapshot;
}

/** Validate cloud data before it reaches the existing stores and room engine. */
export function applyLocalData(snapshot: Snapshot) {
	const patch: Partial<Settings> = {};
	if (snapshot["settings/discordRpc"] == null) patch.discordRpc = false;
	for (const key of settingKeys) {
		const value = snapshot[`settings/${key}`];
		if (value !== undefined && syncedSettings[key](value))
			Object.assign(patch, { [key]: value });
	}
	const scrobbling = snapshot[SCROBBLE_SYNC_KEY];
	if (scrobbling === undefined || scrobbling === null)
		Object.assign(patch, { listenbrainz: false, listenbrainzToken: "" });
	else if (validScrobbling(scrobbling))
		Object.assign(patch, {
			listenbrainz: scrobbling.enabled,
			listenbrainzToken: scrobbling.token,
		});
	updateSettings(patch);
	const pinned = [];
	const people = [];
	for (const [key, value] of Object.entries(snapshot)) {
		if (
			key.startsWith("pinned/") &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			if (
				typeof value.id === "string" &&
				key === `pinned/${encodeURIComponent(value.id)}` &&
				typeof value.title === "string" &&
				value.title.length <= 1000 &&
				(value.thumbnail === null || typeof value.thumbnail === "string")
			)
				pinned.push({
					id: value.id,
					title: value.title,
					thumbnail: value.thumbnail,
				});
		}
		if (
			key.startsWith("trusted/") &&
			validTrustKey(key.slice(8)) &&
			typeof value === "string" &&
			value.length <= 40
		)
			people.push({ fingerprint: key.slice(8), username: value });
	}
	replacePinnedPlaylists(pinned);
	joinSettingsStorage.write({
		policy: validPolicy(snapshot.joinPolicy) ? snapshot.joinPolicy : "manual",
		people: people.slice(0, 100),
	});
	replaceSavedGuestPermissions(
		validPermissions(snapshot.guestPermissions)
			? snapshot.guestPermissions
			: null,
	);
	replaceSavedRoomProfile(
		validSavedRoomProfile(snapshot.roomProfile) ? snapshot.roomProfile : null,
	);
	window.dispatchEvent(new Event(ROOM_SETTINGS_RELOADED));
}
