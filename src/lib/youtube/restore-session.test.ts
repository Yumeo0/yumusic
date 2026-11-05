import { describe, expect, test } from "bun:test";
import { restoreSession } from "./restore-session";

describe("saved session restoration", () => {
	test("recovers rotated browser cookies after a startup profile failure", async () => {
		const calls: [string, boolean][] = [];
		const profile = { name: "Selected account" };
		const result = await restoreSession("saved-cookie", {
			loadProfile: async (cookie, refresh) => {
				calls.push([cookie, refresh]);
				if (!refresh) throw new Error("Account request failed");
				return profile;
			},
			validateSession: async () => "rotated-cookie",
		});
		expect(result).toEqual({ signedIn: true, profile });
		expect(calls).toEqual([
			["saved-cookie", false],
			["rotated-cookie", true],
		]);
	});

	test("keeps a verified session signed in when both profile requests fail", async () => {
		expect(
			await restoreSession("saved-cookie", {
				loadProfile: async () => {
					throw new Error("Account service unavailable");
				},
				validateSession: async () => "saved-cookie",
			}),
		).toEqual({ signedIn: true, profile: null });
	});

	test("does not treat inconclusive verification as a signed-out verdict", async () => {
		const offline = new Error("Offline");
		await expect(
			restoreSession("saved-cookie", {
				loadProfile: async () => null,
				validateSession: async () => {
					throw offline;
				},
			}),
		).rejects.toBe(offline);
	});

	test("honors an explicit expired session even after a profile error", async () => {
		expect(
			await restoreSession("expired-cookie", {
				loadProfile: async () => {
					throw new Error("Unauthorized");
				},
				validateSession: async () => null,
			}),
		).toEqual({ signedIn: false, profile: null });
	});

	test("restores a usable profile without another verification request", async () => {
		const profile = { name: "Selected account" };
		expect(
			await restoreSession("saved-cookie", {
				loadProfile: async () => profile,
				validateSession: async () => {
					throw new Error("Should not verify an authenticated profile");
				},
			}),
		).toEqual({ signedIn: true, profile });
	});
});
