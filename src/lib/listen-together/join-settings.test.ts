import { describe, expect, test } from "bun:test";
import { joinSettingsStorage, validPolicy } from "./join-settings";

function withStorage(
	initial: string | null,
	run: () => void,
	legacy: string | null = null,
) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	let raw = initial;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) =>
				key === "yumusic:join-settings:v1" ? legacy : raw,
			setItem: (_key: string, value: string) => {
				raw = value;
			},
		},
	});
	try {
		run();
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
}

describe("saved room join settings", () => {
	test("fresh rooms auto-approve everyone", () => {
		withStorage(null, () =>
			expect(joinSettingsStorage.read()).toEqual({
				policy: "everyone",
				people: [],
			}),
		);
	});
	test("legacy strict trusted policy keeps its admission restriction", () => {
		const person = { fingerprint: "a".repeat(64), username: "Friend" };
		withStorage(
			null,
			() =>
				expect(joinSettingsStorage.read()).toEqual({
					policy: "trusted-only",
					people: [person],
				}),
			JSON.stringify({ policy: "trusted", people: [person] }),
		);
	});
	test("existing auto-approve everyone choices are preserved", () => {
		withStorage(
			null,
			() => expect(joinSettingsStorage.read().policy).toBe("everyone"),
			JSON.stringify({ policy: "everyone", people: [] }),
		);
	});
	test("explicit saved choices take precedence over defaults and legacy settings", () => {
		withStorage(
			JSON.stringify({ policy: "manual", people: [] }),
			() => expect(joinSettingsStorage.read().policy).toBe("manual"),
			JSON.stringify({ policy: "trusted", people: [] }),
		);
	});
	test("only explicit string policies can enable automatic approval", () => {
		for (const value of [null, {}, ["everyone"], 1, "unknown"]) {
			expect(validPolicy(value)).toBe(false);
			withStorage(JSON.stringify({ policy: value }), () =>
				expect(joinSettingsStorage.read().policy).toBe("manual"),
			);
		}
	});
	test("malformed saved keys cannot enter the trusted list", () => {
		withStorage(
			JSON.stringify({
				policy: "trusted",
				people: [
					{ fingerprint: ["a".repeat(64)], username: "Invalid array" },
					{ fingerprint: "not-a-fingerprint", username: "Invalid" },
					{ fingerprint: "a".repeat(64), username: "Friend" },
				],
			}),
			() =>
				expect(joinSettingsStorage.read().people).toEqual([
					{ fingerprint: "a".repeat(64), username: "Friend" },
				]),
		);
	});
	test("policy and explicitly trusted fingerprints survive saving and reading", () => {
		withStorage("not json", () => {
			expect(joinSettingsStorage.read()).toEqual({
				policy: "manual",
				people: [],
			});
			const settings = {
				policy: "trusted" as const,
				people: [{ fingerprint: "b".repeat(64), username: "Friend" }],
			};
			joinSettingsStorage.write(settings);
			expect(joinSettingsStorage.read()).toEqual(settings);
		});
	});
});
