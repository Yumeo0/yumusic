import {
	defaultPermissions,
	validPermissions,
} from "../listen-together/guest-permissions";
import {
	joinSettingsStorage,
	validPolicy,
	validTrustKey,
} from "../listen-together/join-settings";
import { validProfile } from "../listen-together/profile";
import { getPinnedPlaylists } from "../stores/pinned";
import { getSettings, type Settings, updateSettings } from "../stores/settings";
import type { Snapshot, SyncValue } from "./records";

// Explicit preference allowlist. ListenBrainz configuration is synced as one
// record below; app login credentials and device-specific options stay local.
export const SYNC_SETTINGS = [
	"discordRpc",
	"romanizeLyrics",
	"titleMode",
	"cleanTitles",
	"lyricsProviderOrder",
	"preferSyncedLyrics",
	"lrclibLooseMatch",
	"hiddenHomeSections",
	"autoplay",
	"repeatMode",
	"crossfade",
	"crossfadeSeconds",
	"watchHistory",
] as const satisfies readonly (keyof Settings)[];

export const SCROBBLE_SYNC_KEY = "settings/scrobbling";
export function supportsSyncKey(key: string) {
	return (
		key === SCROBBLE_SYNC_KEY ||
		SYNC_SETTINGS.some((setting) => key === `settings/${setting}`) ||
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

/** Preserve the previously device-local configuration in pre-sync backups. */
export function migrateScrobbleBackup() {
	migrateLocalBackup("scrobbling", SCROBBLE_SYNC_KEY);
}

export function migrateRichPresenceBackup() {
	migrateLocalBackup("rich-presence", "settings/discordRpc");
}

function migrateLocalBackup(name: string, key: string) {
	const marker = `yumusic:sync:${name}-migrated:v1`;
	if (localStorage.getItem(marker)) return;
	const raw = localStorage.getItem("yumusic:sync:guest");
	if (raw) {
		const guest = JSON.parse(raw) as Snapshot;
		const value = readLocalData()[key];
		if (guest[key] === undefined && value !== undefined) {
			guest[key] = value;
			localStorage.setItem("yumusic:sync:guest", JSON.stringify(guest));
		}
	}
	localStorage.setItem(marker, "1");
}

function readJson(key: string): unknown {
	const raw = localStorage.getItem(key);
	return raw ? JSON.parse(raw) : null;
}
export function readLocalData(): Snapshot {
	const snapshot: Snapshot = {};
	const settings = getSettings();
	for (const key of SYNC_SETTINGS) {
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
	try {
		const permissions = readJson("yumusic:guest-permissions:v1");
		if (validPermissions(permissions))
			snapshot.guestPermissions = Object.fromEntries(
				Object.keys(defaultPermissions).map((key) => [
					key,
					permissions[key as keyof typeof defaultPermissions],
				]),
			);
		const profile = readJson("yumusic:room-profile:v1") as {
			source?: unknown;
			profile?: unknown;
		} | null;
		if (typeof profile?.source === "string" && validProfile(profile.profile))
			snapshot.roomProfile = {
				source: profile.source,
				profile: { ...profile.profile },
			};
	} catch {
		/* An invalid optional local record is not uploaded. */
	}
	return snapshot;
}

function validSetting(
	key: (typeof SYNC_SETTINGS)[number],
	value: SyncValue,
): boolean {
	switch (key) {
		case "titleMode":
			return ["both", "original", "translation"].includes(String(value));
		case "repeatMode":
			return ["off", "one", "all"].includes(String(value));
		case "crossfadeSeconds":
			return (
				typeof value === "number" &&
				Number.isFinite(value) &&
				value >= 1 &&
				value <= 12
			);
		case "hiddenHomeSections":
			return (
				Array.isArray(value) &&
				value.length <= 500 &&
				value.every((x) => typeof x === "string" && x.length <= 500)
			);
		case "lyricsProviderOrder":
			return (
				Array.isArray(value) &&
				value.length <= 10 &&
				value.every((x) => typeof x === "string")
			);
		default:
			return typeof value === "boolean";
	}
}

/** Validate cloud data before it reaches the existing stores and room engine. */
export function applyLocalData(snapshot: Snapshot) {
	const patch: Partial<Settings> = {};
	if (snapshot["settings/discordRpc"] == null) patch.discordRpc = false;
	for (const key of SYNC_SETTINGS) {
		const value = snapshot[`settings/${key}`];
		if (value !== undefined && validSetting(key, value))
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
	localStorage.setItem("yumusic:pinned", JSON.stringify(pinned));
	window.dispatchEvent(new Event("yumusic:pinned-changed"));
	joinSettingsStorage.write({
		policy: validPolicy(snapshot.joinPolicy) ? snapshot.joinPolicy : "manual",
		people: people.slice(0, 100),
	});
	if (validPermissions(snapshot.guestPermissions))
		localStorage.setItem(
			"yumusic:guest-permissions:v1",
			JSON.stringify(snapshot.guestPermissions),
		);
	else localStorage.removeItem("yumusic:guest-permissions:v1");
	const profile = snapshot.roomProfile;
	if (
		profile &&
		typeof profile === "object" &&
		!Array.isArray(profile) &&
		typeof profile.source === "string" &&
		profile.source.length <= 200 &&
		validProfile(profile.profile)
	)
		localStorage.setItem("yumusic:room-profile:v1", JSON.stringify(profile));
	else localStorage.removeItem("yumusic:room-profile:v1");
	window.dispatchEvent(new Event("yumusic:room-settings-reloaded"));
}
