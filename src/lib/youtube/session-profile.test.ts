import { describe, expect, test } from "bun:test";
import { readSessionProfile } from "./session-profile";

type Client = Parameters<typeof readSessionProfile>[0];
const account = (name: string, selected = false, disabled = false) => ({
	account_name: { text: name },
	account_photo: [{ url: "https://example.com/avatar.jpg" }],
	is_selected: selected,
	is_disabled: disabled,
});
const client = (getInfo: Client["account"]["getInfo"]): Client => ({
	session: { logged_in: true },
	account: { getInfo },
});

describe("Google session validation", () => {
	test("uses the selected account from the cookie-compatible endpoint", async () => {
		const profile = await readSessionProfile(
			client(async (all) => {
				expect(all).toBe(true);
				return [account("Other"), account("Selected", true)];
			}),
		);
		expect(profile).toEqual({
			name: "Selected",
			photo: "https://example.com/avatar.jpg",
		});
	});

	test("rejects stale cookies returning no accounts", async () => {
		expect(await readSessionProfile(client(async () => []))).toBeNull();
	});

	test("rejects nameless and disabled accounts instead of showing User", async () => {
		for (const accounts of [[account(" ")], [account("Old", true, true)]]) {
			expect(await readSessionProfile(client(async () => accounts))).toBeNull();
		}
	});

	test("rejects a session the client already knows is signed out", async () => {
		const signedOut = client(async () => {
			throw new Error("Must not request accounts");
		});
		signedOut.session.logged_in = false;
		expect(await readSessionProfile(signedOut)).toBeNull();
	});

	test("treats an explicit HTTP 401 as an expired session", async () => {
		const expired = client(async () => {
			throw new Error(
				"Request to https://www.youtube.com/youtubei/v1/account/accounts_list failed with status code 401",
			);
		});
		expect(await readSessionProfile(expired)).toBeNull();
	});

	test("preserves cookies on network, rate-limit and server failures", async () => {
		for (const message of [
			"Failed to fetch",
			"failed with status code 429",
			"failed with status code 500",
		]) {
			const error = new Error(message);
			await expect(
				readSessionProfile(
					client(async () => {
						throw error;
					}),
				),
			).rejects.toBe(error);
		}
	});
});
