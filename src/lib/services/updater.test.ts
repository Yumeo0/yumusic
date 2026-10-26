import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, installUpdate, updaterSupported } from "./updater";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
const calls: string[] = [];

beforeEach(() => {
	calls.length = 0;
	Object.defineProperty(globalThis, "isTauri", {
		configurable: true,
		value: true,
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			__YUMUSIC_SELF_UPDATE_SUPPORTED__: false,
			__TAURI_INTERNALS__: {
				invoke: async (command: string) => {
					calls.push(command);
					return null;
				},
			},
		},
	});
});

afterEach(() => {
	for (const [key, descriptor] of [
		["window", originalWindow],
		["isTauri", originalTauri],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("distribution-managed updates", () => {
	test("does not contact the updater when the native plugin is disabled", async () => {
		expect(updaterSupported()).toBe(false);
		expect(await checkForUpdate()).toBeNull();
		expect(calls).toEqual([]);
	});

	test("rejects installation before invoking disabled native plugins", async () => {
		const update = new Update({
			rid: 1,
			currentVersion: "0.5.1",
			version: "0.5.2",
			rawJson: {},
		});
		await expect(installUpdate(update)).rejects.toThrow("managed");
		expect(calls).toEqual([]);
	});

	test("uses the updater in native builds that enable it", async () => {
		Object.defineProperty(window, "__YUMUSIC_SELF_UPDATE_SUPPORTED__", {
			value: true,
		});
		expect(updaterSupported()).toBe(true);
		expect(await checkForUpdate()).toBeNull();
		expect(calls).toEqual(["plugin:updater|check"]);
	});

	test("requires a native capability flag even in a Tauri window", () => {
		Reflect.deleteProperty(window, "__YUMUSIC_SELF_UPDATE_SUPPORTED__");
		expect(updaterSupported()).toBe(false);
	});
});
