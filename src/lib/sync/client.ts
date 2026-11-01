import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { syncSessionToken } from "./youtube-account";

// Publishable credentials identify the app, not an administrative user.
// Data authorization is enforced by RLS, including in development builds.
export const SUPABASE_URL = "https://cousozghjxwjwnnnlnjd.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_QmbhYP6Aah3ESm9MQcBJzA_MtFQ5re3";
export const supabase = createClient<Database>(SUPABASE_URL, PUBLISHABLE_KEY, {
	auth: {
		flowType: "pkce",
		detectSessionInUrl: false,
		storageKey: "yumusic-sync-auth",
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
