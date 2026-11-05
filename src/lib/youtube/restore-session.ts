interface SessionRecovery<Profile> {
	loadProfile: (cookie: string, refresh: boolean) => Promise<Profile | null>;
	validateSession: () => Promise<string | null>;
}

/** Profile requests can fail independently of the persisted Google session. */
export async function restoreSession<Profile>(
	cookie: string,
	{ loadProfile, validateSession }: SessionRecovery<Profile>,
) {
	try {
		const profile = await loadProfile(cookie, false);
		if (profile) return { signedIn: true, profile };
	} catch {
		// Still try native verification and recovery of rotated browser cookies.
	}

	// Let inconclusive verification throw so the caller preserves state and retries.
	const verifiedCookie = await validateSession();
	if (!verifiedCookie) return { signedIn: false, profile: null };

	let profile: Profile | null = null;
	try {
		profile = await loadProfile(verifiedCookie, true);
	} catch {
		// A verified session remains signed in even if account metadata is unavailable.
	}
	return { signedIn: true, profile };
}
