import { useEffect, useRef, useState } from "react";
import { showToast } from "../stores/toast";
import { signInWithGoogle, signOutOfSync } from "../sync/sync";
import {
	getYouTubeSyncAccount,
	setYouTubeSyncAccount,
} from "../sync/youtube-account";
import { getYoutubeClient } from "./client-session";
import { restoreSession } from "./restore-session";
import { getUserProfile } from "./youtube-client";

export function useYouTubeSession() {
	const authRevision = useRef(0);
	const authBusy = useRef(false);
	const [isLoggedIn, setIsLoggedIn] = useState(false);
	const [userProfile, setUserProfile] = useState<{
		name?: string;
		photo?: string;
		email?: string;
	} | null>(null);

	useEffect(() => {
		let disposed = false;
		let checking = false;
		let retryTimer: number | undefined;
		const checkLogin = async () => {
			if (checking || authBusy.current || document.visibilityState === "hidden")
				return;
			window.clearTimeout(retryTimer);
			checking = true;
			const revision = authRevision.current;
			try {
				const cookie = await window.electron.getCookie();
				if (!cookie) {
					if (!disposed && revision === authRevision.current)
						setYouTubeSyncAccount({ status: "signed-out" });
					return;
				}
				const { signedIn, profile } = await restoreSession(cookie, {
					loadProfile: async (sessionCookie, refresh) => {
						await getYoutubeClient(sessionCookie, refresh);
						return getUserProfile();
					},
					validateSession: () => window.electron.validateSession(),
				});
				if (disposed || revision !== authRevision.current) return;
				// Profile metadata is optional. A missing name must never erase the
				// saved session or shared browser cookies.
				if (profile || !signedIn) setUserProfile(profile);
				setIsLoggedIn(signedIn);
				setYouTubeSyncAccount(
					!signedIn
						? { status: "signed-out" }
						: profile?.email
							? { status: "ready", email: profile.email }
							: { status: "unavailable" },
				);
			} catch (error) {
				// Offline, rate-limited and server failures do not invalidate cookies.
				console.error("Failed to check Google session:", error);
				if (!disposed && revision === authRevision.current)
					retryTimer = window.setTimeout(checkLogin, 15_000);
			} finally {
				checking = false;
			}
		};
		void checkLogin();
		window.addEventListener("focus", checkLogin);
		document.addEventListener("visibilitychange", checkLogin);
		const timer = window.setInterval(checkLogin, 5 * 60 * 1000);
		return () => {
			disposed = true;
			window.clearTimeout(retryTimer);
			window.removeEventListener("focus", checkLogin);
			document.removeEventListener("visibilitychange", checkLogin);
			window.clearInterval(timer);
		};
	}, []);

	const handleLogin = async () => {
		if (authBusy.current) return;
		authBusy.current = true;
		authRevision.current += 1;
		const previousAccount = getYouTubeSyncAccount();
		setYouTubeSyncAccount({ status: "checking" });
		try {
			const cookie = await window.electron.login();
			if (!cookie) {
				setYouTubeSyncAccount(previousAccount);
				return;
			}
			await getYoutubeClient(cookie, true);
			const profile = await getUserProfile();
			setIsLoggedIn(true);
			setUserProfile(profile);
			setYouTubeSyncAccount(
				profile?.email
					? { status: "ready", email: profile.email }
					: { status: "unavailable" },
			);
			if (profile?.email) {
				try {
					await signInWithGoogle();
				} catch {
					/* YouTube stays signed in if optional sync consent is cancelled. */
				}
			}
			// The native login command already verified the session with YouTube.
			// Refetch all mounted views with the validated session.
			window.location.reload();
		} catch (error) {
			setYouTubeSyncAccount(previousAccount);
			console.error("Google sign-in failed:", error);
			showToast("Could not verify Google sign-in. Please try again.");
		} finally {
			authBusy.current = false;
		}
	};

	const handleLogout = async () => {
		if (authBusy.current) return;
		authBusy.current = true;
		authRevision.current += 1;
		const previousAccount = getYouTubeSyncAccount();
		setYouTubeSyncAccount({ status: "signed-out" });
		try {
			await signOutOfSync();
			await window.electron.logout();
			setIsLoggedIn(false);
			setUserProfile(null);
			window.location.reload();
		} catch (error) {
			setYouTubeSyncAccount(previousAccount);
			console.error("Google sign-out failed:", error);
			showToast("Could not clear Google sign-in. Please try again.");
		} finally {
			authBusy.current = false;
		}
	};

	return { handleLogin, handleLogout, isLoggedIn, userProfile };
}
