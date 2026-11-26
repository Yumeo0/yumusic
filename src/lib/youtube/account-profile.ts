import { type Innertube, Parser, YTNodes } from "youtubei.js/web";
import { getYoutubeClient } from "./client-session";
import { readSessionProfile, selectedGoogleEmail } from "./session-profile";

export async function getUserProfile(sessionClient?: Innertube) {
	const client = sessionClient ?? (await getYoutubeClient());
	return readSessionProfile({
		session: client.session,
		account: {
			getInfo: async () => {
				// The default WEB menu retains the owning Google account header.
				// The full channel-switcher page omits that identity information.
				const response = await client.actions.execute(
					"/account/accounts_list",
					{ client: "WEB" },
				);
				const email = selectedGoogleEmail(response.data);
				const parsed = Parser.parseResponse(response.data);
				return (parsed.actions_memo?.getType(YTNodes.AccountItem) ?? []).map(
					(item) => ({
						...item,
						google_email: item.is_selected ? email : undefined,
					}),
				);
			},
		},
	});
}
