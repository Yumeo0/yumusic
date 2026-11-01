import { validAccountId } from "../../../supabase/functions/_shared/account-proof";
import { notifySyncChange } from "../sync/events";

export const validTrustKey = (value: unknown): value is string =>
	typeof value === "string" &&
	(/^[a-f0-9]{64}$/.test(value) ||
		(value.startsWith("account:") && validAccountId(value.slice(8))));

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
			const saved = JSON.parse(current ?? legacy ?? "null");
			const policy = saved?.policy;
			const people = Array.isArray(saved?.people)
				? saved.people
						.filter(
							(person: TrustedPerson) =>
								person &&
								validTrustKey(person.fingerprint) &&
								typeof person.username === "string" &&
								person.username.length <= 40,
						)
						.slice(0, 100)
				: [];
			return {
				// Older "trusted" meant strictly trusted-only. Preserve that choice.
				policy:
					legacy !== null && policy === "trusted"
						? "trusted-only"
						: validPolicy(policy)
							? policy
							: "manual",
				people,
			};
		} catch {
			return { policy: "manual", people: [] };
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
