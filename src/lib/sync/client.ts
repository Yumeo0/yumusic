import { createClient, type Session } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { syncSessionToken, YOUTUBE_ACCOUNT_CHANGED } from "./youtube-account";

// Publishable credentials identify the app, not an administrative user.
// Data authorization is enforced by RLS, including in development builds.
export const SUPABASE_URL = "https://cousozghjxwjwnnnlnjd.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_QmbhYP6Aah3ESm9MQcBJzA_MtFQ5re3";
export const AUTH_STORAGE_KEY = "yumusic-sync-auth";
export const supabase = createClient<Database>(SUPABASE_URL, PUBLISHABLE_KEY, {
	auth: {
		flowType: "pkce",
		detectSessionInUrl: false,
		storageKey: AUTH_STORAGE_KEY,
	},
});

/** Bind every data request to its intended account, even across auth changes. */
export function accountDataClient(owner: string) {
	return createClient<Database>(SUPABASE_URL, PUBLISHABLE_KEY, {
		accessToken: async () => {
			const {
				data: { session },
				error,
			} = await supabase.auth.getSession();
			if (error) throw error;
			return syncSessionToken(owner, session);
		},
	});
}

export function watchSyncAccount(onChange: (session: Session | null) => void) {
	let session: Session | null = null;
	let deferred: ReturnType<typeof setTimeout> | undefined;
	const reconcile = () => onChange(session);
	const {
		data: { subscription },
	} = supabase.auth.onAuthStateChange((_event, next) => {
		session = next;
		// Reconciliation can make requests that refresh the session.
		clearTimeout(deferred);
		deferred = setTimeout(reconcile, 0);
	});
	window.addEventListener(YOUTUBE_ACCOUNT_CHANGED, reconcile);
	return () => {
		subscription.unsubscribe();
		clearTimeout(deferred);
		window.removeEventListener(YOUTUBE_ACCOUNT_CHANGED, reconcile);
	};
}
