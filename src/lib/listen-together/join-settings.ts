import {
	validAccountId,
	validFingerprint,
} from "../../../supabase/functions/_shared/account-proof";
import { notifySyncChange } from "../sync/events";

const ACCOUNT_TRUST_PREFIX = "account:";
export const MAX_TRUSTED_PEOPLE = 100;
export const accountTrustKey = (accountId: string) =>
	`${ACCOUNT_TRUST_PREFIX}${accountId}`;

export const validTrustKey = (value: unknown): value is string =>
	validFingerprint(value) ||
	(typeof value === "string" &&
		value.startsWith(ACCOUNT_TRUST_PREFIX) &&
		validAccountId(value.slice(ACCOUNT_TRUST_PREFIX.length)));

export type JoinPolicy = "manual" | "everyone" | "trusted" | "trusted-only";
export interface TrustedPerson {
	fingerprint: string;
	username: string;
}
export interface JoinSettings {
	policy: JoinPolicy;
	people: TrustedPerson[];
}
export interface JoinSettingsStorage {
	read: () => JoinSettings;
	write: (value: JoinSettings) => void;
}
const KEY = "yumusic:join-settings:v2";
export const validPolicy = (value: unknown): value is JoinPolicy =>
	typeof value === "string" &&
	["manual", "everyone", "trusted", "trusted-only"].includes(value);

function validTrustedPerson(value: unknown): value is TrustedPerson {
	if (!value || typeof value !== "object") return false;
	const { fingerprint, username } = value as Partial<TrustedPerson>;
	return (
		validTrustKey(fingerprint) &&
		typeof username === "string" &&
		username.length <= 40
	);
}

export function normalizeJoinSettings(
	policy: unknown,
	people: unknown,
): JoinSettings {
	return {
		policy: validPolicy(policy) ? policy : "manual",
		people: Array.isArray(people)
			? people.filter(validTrustedPerson).slice(0, MAX_TRUSTED_PEOPLE)
			: [],
	};
}

export const joinSettingsStorage: JoinSettingsStorage = {
	read() {
		try {
			const current = localStorage.getItem(KEY);
			const legacy =
				current === null
					? localStorage.getItem("yumusic:join-settings:v1")
					: null;
			if (current === null && legacy === null)
				return { policy: "everyone", people: [] };
			const saved = JSON.parse(current ?? legacy ?? "null") as {
				policy?: unknown;
				people?: unknown;
			} | null;
			// Older "trusted" meant strictly trusted-only.
			const policy =
				legacy !== null && saved?.policy === "trusted"
					? "trusted-only"
					: saved?.policy;
			return normalizeJoinSettings(policy, saved?.people);
		} catch {
			return normalizeJoinSettings(null, null);
		}
	},
	write(value) {
		try {
			localStorage.setItem(KEY, JSON.stringify(value));
			notifySyncChange();
		} catch {
			throw new Error(
				"Could not save join settings. Check app storage permissions.",
			);
		}
	},
};
