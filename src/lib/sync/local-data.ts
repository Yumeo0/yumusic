import {
	readSavedGuestPermissions,
	replaceSavedGuestPermissions,
	validPermissions,
} from "../listen-together/guest-permissions";
import {
	joinSettingsStorage,
	normalizeJoinSettings,
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
	replaceSettings,
	type Settings,
} from "../stores/settings";
import { ROOM_SETTINGS_RELOADED } from "./events";
import {
	type Snapshot,
	type SyncValue,
	TRUSTED_RECORD_PREFIX,
} from "./records";

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

type Setting = keyof typeof syncedSettings;
// A default-off device publishes no value until rich presence is enabled.
const omittedDefaults: Partial<Record<Setting, SyncValue>> = {
	discordRpc: false,
};
const settingRecords = (Object.keys(syncedSettings) as Setting[]).map(
	(name) => ({
		name,
		key: `settings/${name}`,
		validate: syncedSettings[name],
		omittedDefault: omittedDefaults[name],
	}),
);
const PINNED_RECORD_PREFIX = "pinned/";
const JOIN_POLICY_KEY = "joinPolicy";
const GUEST_PERMISSIONS_KEY = "guestPermissions";
const ROOM_PROFILE_KEY = "roomProfile";
export const GUEST_BACKUP_KEY = "yumusic:sync:guest";

export const SCROBBLE_SYNC_KEY = "settings/scrobbling";

function trustedFingerprint(key: string) {
	if (!key.startsWith(TRUSTED_RECORD_PREFIX)) return null;
	const fingerprint = key.slice(TRUSTED_RECORD_PREFIX.length);
	return validTrustKey(fingerprint) ? fingerprint : null;
}

const pinnedRecordKey = (id: string) =>
	`${PINNED_RECORD_PREFIX}${encodeURIComponent(id)}`;

export function supportsSyncKey(key: string) {
	return (
		key === SCROBBLE_SYNC_KEY ||
		settingRecords.some((setting) => key === setting.key) ||
		key.startsWith(PINNED_RECORD_PREFIX) ||
		trustedFingerprint(key) !== null ||
		[JOIN_POLICY_KEY, GUEST_PERMISSIONS_KEY, ROOM_PROFILE_KEY].includes(key)
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
	for (const { name, key, validate, omittedDefault } of settingRecords) {
		const value = settings[name];
		if (
			omittedDefault === undefined ||
			(validate(value) && value !== omittedDefault)
		)
			snapshot[key] = value;
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
		snapshot[pinnedRecordKey(pinned.id)] = { ...pinned };
	const joins = joinSettingsStorage.read();
	snapshot[JOIN_POLICY_KEY] = joins.policy;
	for (const person of joins.people)
		snapshot[`${TRUSTED_RECORD_PREFIX}${person.fingerprint}`] = person.username;
	const permissions = readSavedGuestPermissions();
	if (permissions) snapshot[GUEST_PERMISSIONS_KEY] = permissions;
	const profile = readSavedRoomProfile();
	if (profile)
		snapshot[ROOM_PROFILE_KEY] = {
			source: profile.source,
			profile: { ...profile.profile },
		};
	return snapshot;
}

export function applyLocalData(snapshot: Snapshot) {
	const patch: Partial<Settings> = {};
	for (const { name, key, validate, omittedDefault } of settingRecords) {
		const value = snapshot[key] ?? omittedDefault;
		if (value !== undefined && validate(value))
			Object.assign(patch, { [name]: value });
	}
	const scrobbling = snapshot[SCROBBLE_SYNC_KEY];
	if (scrobbling === undefined || scrobbling === null)
		Object.assign(patch, { listenbrainz: false, listenbrainzToken: "" });
	else if (validScrobbling(scrobbling))
		Object.assign(patch, {
			listenbrainz: scrobbling.enabled,
			listenbrainzToken: scrobbling.token,
		});
	replaceSettings({ ...getSettings(), ...patch });
	const pinned = [];
	const people = [];
	for (const [key, value] of Object.entries(snapshot)) {
		if (
			key.startsWith(PINNED_RECORD_PREFIX) &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			if (
				typeof value.id === "string" &&
				key === pinnedRecordKey(value.id) &&
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
		const fingerprint = trustedFingerprint(key);
		if (fingerprint) people.push({ fingerprint, username: value });
	}
	replacePinnedPlaylists(pinned);
	joinSettingsStorage.write(
		normalizeJoinSettings(snapshot[JOIN_POLICY_KEY], people),
	);
	const permissions = snapshot[GUEST_PERMISSIONS_KEY];
	replaceSavedGuestPermissions(
		validPermissions(permissions) ? permissions : null,
	);
	const profile = snapshot[ROOM_PROFILE_KEY];
	replaceSavedRoomProfile(validSavedRoomProfile(profile) ? profile : null);
	window.dispatchEvent(new Event(ROOM_SETTINGS_RELOADED));
}
