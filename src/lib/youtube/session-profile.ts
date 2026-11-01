interface SessionAccount {
	is_selected?: boolean;
	is_disabled?: boolean;
	account_name?: { text?: string };
	account_photo?: { url: string }[];
	channel_handle?: { text?: string };
	google_email?: string;
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
	const email = selected?.google_email;
	return {
		name,
		photo: selected?.account_photo?.[0]?.url,
		...(accountId ? { accountId } : {}),
		...(email ? { email } : {}),
	};
}

/** Read the owning Google email from the selected channel's authenticated
 * account section. Brand Account channel names and handles are not identities. */
export function selectedGoogleEmail(raw: unknown): string | undefined {
	const emails = new Set<string>();
	const record = (v: unknown): v is Record<string, unknown> =>
		!!v && typeof v === "object" && !Array.isArray(v);
	const hasSelectedAccount = (value: unknown, depth = 0): boolean => {
		if (depth > 30 || !value || typeof value !== "object") return false;
		if (record(value)) {
			const item = value.accountItem ?? value.accountItemRenderer;
			if (record(item) && item.isSelected === true && item.isDisabled !== true)
				return true;
		}
		return Object.values(value).some((child) =>
			hasSelectedAccount(child, depth + 1),
		);
	};
	const visit = (value: unknown, depth = 0) => {
		if (depth > 30 || !value || typeof value !== "object") return;
		if (record(value) && record(value.accountSectionListRenderer)) {
			const section = value.accountSectionListRenderer;
			const header = record(section.header)
				? section.header.googleAccountHeaderRenderer
				: null;
			const emailNode =
				record(header) && record(header.email) ? header.email : null;
			const text = emailNode?.simpleText;
			if (
				typeof text === "string" &&
				/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim()) &&
				hasSelectedAccount(section.contents)
			)
				emails.add(text.trim().toLowerCase());
		}
		for (const child of Object.values(value)) visit(child, depth + 1);
	};
	visit(raw);
	return emails.size === 1 ? [...emails][0] : undefined;
}
