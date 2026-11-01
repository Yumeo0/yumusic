import { afterEach, beforeEach, expect, test } from "bun:test";
import { defaultPermissions } from "../listen-together/guest-permissions";
import {
	applyLocalData,
	migrateRichPresenceBackup,
	migrateScrobbleBackup,
	readLocalData,
	SCROBBLE_SYNC_KEY,
	supportsSyncKey,
} from "./local-data";

const storage = new Map<string, string>();
const descriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	storage.clear();
	for (const name of ["window", "localStorage"])
		descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: new EventTarget(),
	});
});
afterEach(() => {
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

test("sync only uploads the explicit preferences and ListenBrainz configuration", () => {
	storage.set(
		"yumusic:settings:v1",
		JSON.stringify({
			cleanTitles: false,
			listenbrainzToken: "private-token",
			downloadedPlaylists: ["local-download"],
			discordRpc: true,
			futureSecret: "never-sync",
			youtubeCookie: "private-cookie",
		}),
	);
	storage.set(
		"yumusic:guest-permissions:v1",
		JSON.stringify({
			...defaultPermissions,
			secret: "private-permission-extra",
		}),
	);
	const data = readLocalData();
	expect(data["settings/cleanTitles"]).toBe(false);
	expect(data["settings/discordRpc"]).toBe(true);
	expect(data[SCROBBLE_SYNC_KEY]).toEqual({
		enabled: false,
		token: "private-token",
	});
	for (const secret of [
		"private-cookie",
		"local-download",
		"futureSecret",
		"private-permission-extra",
	])
		expect(JSON.stringify(data)).not.toContain(secret);
});

test("rich presence imports on a default-off device and disabling it removes the sync value", () => {
	const key = "settings/discordRpc";
	expect(supportsSyncKey(key)).toBe(true);
	const defaults = readLocalData();
	expect(defaults[key]).toBeUndefined();
	applyLocalData({ ...defaults, [key]: true });
	expect(readLocalData()[key]).toBe(true);
	applyLocalData({ ...defaults, [key]: "invalid" });
	expect(readLocalData()[key]).toBe(true);
	applyLocalData({ ...defaults, [key]: null });
	expect(readLocalData()[key]).toBeUndefined();
	expect(
		JSON.parse(storage.get("yumusic:settings:v1") || "{}").discordRpc,
	).toBe(false);
});

test("upgrading preserves device-local rich presence in the sign-out backup", () => {
	storage.set("yumusic:sync:guest", JSON.stringify(readLocalData()));
	storage.set("yumusic:settings:v1", JSON.stringify({ discordRpc: true }));
	migrateRichPresenceBackup();
	const backup = storage.get("yumusic:sync:guest") || "{}";
	expect(JSON.parse(backup)["settings/discordRpc"]).toBe(true);
	applyLocalData({});
	migrateRichPresenceBackup();
	expect(storage.get("yumusic:sync:guest")).toBe(backup);
	applyLocalData(JSON.parse(backup));
	expect(readLocalData()["settings/discordRpc"]).toBe(true);
});

test("a fresh mobile device imports scrobbling without publishing empty defaults", () => {
	const mobile = readLocalData();
	expect(mobile[SCROBBLE_SYNC_KEY]).toBeUndefined();
	applyLocalData({
		...mobile,
		[SCROBBLE_SYNC_KEY]: { enabled: true, token: "test-listenbrainz-token" },
	});
	const saved = JSON.parse(storage.get("yumusic:settings:v1") || "{}");
	expect(saved.listenbrainz).toBe(true);
	expect(saved.listenbrainzToken).toBe("test-listenbrainz-token");
	expect(readLocalData()[SCROBBLE_SYNC_KEY]).toEqual({
		enabled: true,
		token: "test-listenbrainz-token",
	});
});

test("disabling scrobbling keeps its token, while clearing the configuration removes it", () => {
	const data = readLocalData();
	applyLocalData({
		...data,
		[SCROBBLE_SYNC_KEY]: { enabled: false, token: "saved-token" },
	});
	expect(readLocalData()[SCROBBLE_SYNC_KEY]).toEqual({
		enabled: false,
		token: "saved-token",
	});
	applyLocalData(data);
	expect(readLocalData()[SCROBBLE_SYNC_KEY]).toBeUndefined();
	const saved = JSON.parse(storage.get("yumusic:settings:v1") || "{}");
	expect(saved.listenbrainz).toBe(false);
	expect(saved.listenbrainzToken).toBe("");
});

test("upgrading preserves the original device's scrobbling in its sign-out backup", () => {
	storage.set("yumusic:sync:guest", JSON.stringify(readLocalData()));
	storage.set(
		"yumusic:settings:v1",
		JSON.stringify({
			listenbrainz: true,
			listenbrainzToken: "original-device-token",
		}),
	);
	migrateScrobbleBackup();
	const backup = JSON.parse(storage.get("yumusic:sync:guest") || "{}");
	expect(backup[SCROBBLE_SYNC_KEY]).toEqual({
		enabled: true,
		token: "original-device-token",
	});
	applyLocalData({
		...backup,
		[SCROBBLE_SYNC_KEY]: { enabled: true, token: "cloud-token" },
	});
	migrateScrobbleBackup();
	applyLocalData(JSON.parse(storage.get("yumusic:sync:guest") || "{}"));
	expect(readLocalData()[SCROBBLE_SYNC_KEY]).toEqual({
		enabled: true,
		token: "original-device-token",
	});
});

test("malformed cloud scrobble settings cannot replace a valid local configuration", () => {
	storage.set(
		"yumusic:settings:v1",
		JSON.stringify({ listenbrainz: true, listenbrainzToken: "existing-token" }),
	);
	for (const value of [
		{ enabled: "yes", token: "bad" },
		{ enabled: true, token: "bad\nheader" },
		{ enabled: true, token: "a".repeat(257) },
	]) {
		applyLocalData({ ...readLocalData(), [SCROBBLE_SYNC_KEY]: value });
		expect(readLocalData()[SCROBBLE_SYNC_KEY]).toEqual({
			enabled: true,
			token: "existing-token",
		});
	}
});

test("applying cloud preferences preserves credentials and removes revoked trust", () => {
	storage.set(
		"yumusic:settings:v1",
		JSON.stringify({
			cleanTitles: true,
			listenbrainzToken: "keep-this",
			downloadedPlaylists: ["offline"],
		}),
	);
	storage.set(
		"yumusic:join-settings:v2",
		JSON.stringify({
			policy: "trusted",
			people: [{ fingerprint: "a".repeat(64), username: "Alice" }],
		}),
	);
	const data = readLocalData();
	delete data[`trusted/${"a".repeat(64)}`];
	data["settings/cleanTitles"] = false;
	data["settings/listenbrainzToken"] = "malicious cloud token";
	applyLocalData(data);
	const saved = JSON.parse(storage.get("yumusic:settings:v1") || "{}");
	expect(saved.cleanTitles).toBe(false);
	expect(saved.listenbrainzToken).toBe("keep-this");
	expect(saved.downloadedPlaylists).toEqual(["offline"]);
	expect(
		JSON.parse(storage.get("yumusic:join-settings:v2") || "{}").people,
	).toEqual([]);
});

test("invalid remote settings, profiles and trust entries do not reach the app", () => {
	const data = readLocalData();
	data["settings/titleMode"] = "bad-mode";
	data["settings/crossfadeSeconds"] = -100;
	data["trusted/not-a-key"] = "Mallory";
	data.roomProfile = {
		source: "guest",
		profile: { username: "", avatar: "https://remote.example/image" },
	};
	applyLocalData(data);
	const saved = JSON.parse(storage.get("yumusic:settings:v1") || "{}");
	expect(saved.titleMode).toBe("original");
	expect(saved.crossfadeSeconds).toBe(3);
	expect(storage.has("yumusic:room-profile:v1")).toBe(false);
	expect(
		JSON.parse(storage.get("yumusic:join-settings:v2") || "{}").people,
	).toEqual([]);
});

test("account trust entries sync and their removal does not leave device approvals", () => {
	const accountKey = "account:11111111-1111-4111-8111-111111111111";
	const data = readLocalData();
	data[`trusted/${accountKey}`] = "Friend";
	applyLocalData(data);
	expect(readLocalData()[`trusted/${accountKey}`]).toBe("Friend");
	delete data[`trusted/${accountKey}`];
	applyLocalData(data);
	expect(
		JSON.parse(storage.get("yumusic:join-settings:v2") || "{}").people,
	).toEqual([]);
});
