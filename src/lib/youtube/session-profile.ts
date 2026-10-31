interface SessionAccount {
	is_selected?: boolean;
	is_disabled?: boolean;
	account_name?: { text?: string };
	account_photo?: { url: string }[];
	channel_handle?: { text?: string };
}

interface ProfileClient {
	session: { logged_in: boolean };
	account: { getInfo: (all: true) => Promise<readonly SessionAccount[]> };
}

/** Null means no usable profile; session expiry requires separate verification. */
export async function readSessionProfile(client: ProfileClient) {
	if (!client.session.logged_in) return null;
	let accounts: readonly SessionAccount[];
	try {
		accounts = await client.account.getInfo(true);
	} catch (error) {
		// youtubei.js includes the HTTP status in its request error message.
		if (
			error instanceof Error &&
			/failed with status code 401$/.test(error.message)
		) {
			return null;
		}
		throw error;
	}
	const available = accounts.filter((account) => !account.is_disabled);
	const selected =
		available.find((account) => account.is_selected) ?? available[0];
	const name = selected?.account_name?.text?.trim();
	if (!name) return null;
	const accountId = selected?.channel_handle?.text?.trim();
	return {
		name,
		photo: selected?.account_photo?.[0]?.url,
		...(accountId ? { accountId } : {}),
	};
}
