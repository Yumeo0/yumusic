import type { Session, User } from "@supabase/supabase-js";

export const YOUTUBE_ACCOUNT_CHANGED = "yumusic:youtube-account-changed";
export type YouTubeSyncAccount =
	| { status: "checking" | "signed-out" | "unavailable" }
	| { status: "ready"; email: string };
let account: YouTubeSyncAccount = { status: "checking" };
export const getYouTubeSyncAccount = () => account;
export function setYouTubeSyncAccount(next: YouTubeSyncAccount) {
	if (JSON.stringify(account) === JSON.stringify(next)) return;
	account = next;
	window.dispatchEvent(new Event(YOUTUBE_ACCOUNT_CHANGED));
}

export function matchesYouTubeAccount(
	user: Pick<User, "identities">,
	expected = account,
): boolean {
	if (expected.status !== "ready") return false;
	return !!user.identities?.some(
		(identity) =>
			identity.provider === "google" &&
			typeof identity.identity_data?.email === "string" &&
			identity.identity_data.email.trim().toLowerCase() ===
				expected.email.trim().toLowerCase(),
	);
}
export function youtubeSyncEmail() {
	if (account.status !== "ready")
		throw new Error(
			account.status === "signed-out"
				? "Sign in to YouTube to enable sync."
				: "Could not identify your YouTube Google account. Sign in to YouTube again to enable sync.",
		);
	return account.email;
}

export function syncSessionToken(
	owner: string,
	session: Pick<Session, "user" | "access_token"> | null,
	expected = account,
) {
	if (
		!session ||
		session.user.id !== owner ||
		!matchesYouTubeAccount(session.user, expected)
	)
		throw new Error("Sync is waiting for your YouTube Google account.");
	return session.access_token;
}
