import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSyncExternalStore } from "react";
import { supabase } from "./client";
import { signOutOfSync } from "./sync";
import { matchesYouTubeAccount, youtubeSyncEmail } from "./youtube-account";

let cancel: (() => void) | null = null;
const listeners = new Set<() => void>();
export const useGoogleAuthorization = () =>
	useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => cancel !== null,
	);
const notifyAuthorization = () => {
	for (const listener of listeners) listener();
};
export async function signInWithGoogle() {
	const email = youtubeSyncEmail();
	const current = await supabase.auth.getSession();
	if (current.data.session && matchesYouTubeAccount(current.data.session.user))
		return;
	if (current.data.session) await signOutOfSync();
	if (cancel) throw new Error("Google sign-in is already open.");
	if (!isTauri()) {
		const { error } = await supabase.auth.signInWithOAuth({
			provider: "google",
			options: {
				redirectTo: `${location.origin}${location.pathname}`,
				queryParams: { login_hint: email },
			},
		});
		if (error) throw error;
		return;
	}
	const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	let cleanup: (() => void) | undefined;
	try {
		const {
			promise: result,
			resolve: success,
			reject: failure,
		} = Promise.withResolvers<string>();
		cancel = () => failure(new Error("Google sign-in cancelled."));
		notifyAuthorization();
		// Cancellation can arrive while opening the browser; attach a handler
		// immediately, before awaiting the callback later in this function.
		void result.catch(() => undefined);
		cleanup = await listen<{ nonce: string; code?: string; error?: string }>(
			"sync-oauth-result",
			(event) => {
				if (event.payload.nonce !== nonce) return;
				if (event.payload.code) success(event.payload.code);
				else
					failure(new Error(event.payload.error || "Google sign-in failed."));
			},
		);
		const redirectTo = await invoke<string>("begin_sync_oauth", { nonce });
		const { data, error } = await supabase.auth.signInWithOAuth({
			provider: "google",
			options: {
				redirectTo,
				skipBrowserRedirect: true,
				queryParams: { login_hint: email },
			},
		});
		if (error) throw error;
		if (!data.url) throw new Error("Google did not provide a sign-in URL.");
		await openUrl(data.url);
		const code = await result;
		const { error: exchangeError } =
			await supabase.auth.exchangeCodeForSession(code);
		if (exchangeError) throw exchangeError;
		const {
			data: { session },
		} = await supabase.auth.getSession();
		if (!session || !matchesYouTubeAccount(session.user)) {
			await supabase.auth.signOut({ scope: "local" });
			throw new Error(
				`Use your YouTube Google account (${email}) to enable sync.`,
			);
		}
	} finally {
		cancel = null;
		notifyAuthorization();
		cleanup?.();
		await invoke("cancel_sync_oauth").catch(() => undefined);
	}
}
export function cancelGoogleSignIn() {
	cancel?.();
}

export async function finishBrowserSignIn() {
	if (isTauri()) return;
	const url = new URL(location.href);
	const code = url.searchParams.get("code");
	const error = url.searchParams.get("error_description");
	if (!code && !error) return;
	url.searchParams.delete("code");
	url.searchParams.delete("error");
	url.searchParams.delete("error_description");
	url.searchParams.delete("error_code");
	url.hash = "/settings";
	history.replaceState(null, "", url);
	if (error) throw new Error(error);
	const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
		code || "",
	);
	if (exchangeError) throw exchangeError;
}
