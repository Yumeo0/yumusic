import { expect, test } from "bun:test";
import type { Session } from "@supabase/supabase-js";
import { matchesYouTubeAccount, syncSessionToken } from "./youtube-account";

function user(
	email: string,
	id = "user-a",
	provider = "google",
): Session["user"] {
	return {
		id,
		app_metadata: {},
		user_metadata: { email: "forged@example.com" },
		aud: "authenticated",
		created_at: "",
		identities: [
			{ identity_id: id, id, user_id: id, provider, identity_data: { email } },
		],
	};
}
const expected = { status: "ready", email: "youtube@example.com" } as const;

test("only the same authenticated Google identity matches the YouTube account", () => {
	expect(matchesYouTubeAccount(user("YouTube@example.com"), expected)).toBe(
		true,
	);
	expect(matchesYouTubeAccount(user("another@example.com"), expected)).toBe(
		false,
	);
	expect(
		matchesYouTubeAccount(
			user("youtube@example.com", "user-a", "github"),
			expected,
		),
	).toBe(false);
	expect(matchesYouTubeAccount(user("forged@example.com"), expected)).toBe(
		false,
	);
});

test("sync waits for a known YouTube account and stops when YouTube signs out", () => {
	for (const status of ["checking", "signed-out", "unavailable"] as const)
		expect(matchesYouTubeAccount(user("youtube@example.com"), { status })).toBe(
			false,
		);
});

test("data requests stay bound to their account when Google sessions change", () => {
	const session = {
		user: user("youtube@example.com"),
		access_token: "test-token",
	};
	expect(syncSessionToken("user-a", session, expected)).toBe("test-token");
	expect(() =>
		syncSessionToken(
			"user-a",
			{ ...session, user: user("youtube@example.com", "user-b") },
			expected,
		),
	).toThrow();
	expect(() =>
		syncSessionToken(
			"user-a",
			{ ...session, user: user("another@example.com") },
			expected,
		),
	).toThrow();
	expect(() => syncSessionToken("user-a", null, expected)).toThrow();
	expect(() =>
		syncSessionToken("user-a", session, { status: "signed-out" }),
	).toThrow();
});
