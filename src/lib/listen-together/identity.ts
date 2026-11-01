import { accountBindingPayload } from "../../../supabase/functions/_shared/account-proof";
import type { RoomProfile } from "./profile";

export interface JoinChallenge {
	nonce: string;
	session: string;
	host: string;
	guest: string;
}
export interface RoomIdentity {
	publicKey: string;
	fingerprint: string;
	accountId?: string;
	bindAccount?: (accountId: string, issuedAt: number) => Promise<string>;
	sign: (
		challenge: JoinChallenge,
		token: string,
		profile: RoomProfile,
		purpose?: "join" | "trust",
	) => Promise<string>;
}
const algorithm = { name: "ECDSA", namedCurve: "P-256" };
const signing = { name: "ECDSA", hash: "SHA-256" };
const encode = (bytes: ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = (text: string) =>
	Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function validPublicKey(value: unknown): value is string {
	return typeof value === "string" && /^B[A-Za-z0-9+/]{86}=$/.test(value);
}
export function validSignature(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(value);
}
export const validNonce = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const createNonce = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");

/** Domain separation, room, both routing IDs, and the confirmed profile prevent replay. */
function payload(
	challenge: JoinChallenge,
	token: string,
	profile: RoomProfile,
	publicKey: string,
	purpose: "join" | "trust" = "join",
) {
	return new TextEncoder().encode(
		JSON.stringify([
			purpose === "join" ? "yumusic-listen-join-v2" : "yumusic-listen-trust-v1",
			challenge.session,
			challenge.nonce,
			challenge.host,
			challenge.guest,
			token,
			publicKey,
			profile.username,
			profile.avatar,
		]),
	);
}
async function fingerprint(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}
async function fromKeys(keys: CryptoKeyPair): Promise<RoomIdentity> {
	if (keys.privateKey.extractable || keys.privateKey.type !== "private")
		throw new Error("Invalid room identity key.");
	const raw = await crypto.subtle.exportKey("raw", keys.publicKey);
	const publicKey = encode(raw);
	return {
		publicKey,
		fingerprint: await fingerprint(new Uint8Array(raw)),
		bindAccount: async (accountId, issuedAt) =>
			encode(
				await crypto.subtle.sign(
					signing,
					keys.privateKey,
					accountBindingPayload(accountId, publicKey, issuedAt),
				),
			),
		sign: async (challenge, token, profile, purpose = "join") =>
			encode(
				await crypto.subtle.sign(
					signing,
					keys.privateKey,
					payload(challenge, token, profile, publicKey, purpose),
				),
			),
	};
}

/** Standalone generation is also used by transport tests, without persisting a key. */
export async function generateRoomIdentity(): Promise<RoomIdentity> {
	return fromKeys(
		await crypto.subtle.generateKey(algorithm, false, ["sign", "verify"]),
	);
}

export async function verifyIdentity(
	publicKey: string,
	challenge: JoinChallenge,
	token: string,
	profile: RoomProfile,
	signature: string,
	purpose: "join" | "trust" = "join",
): Promise<string | null> {
	try {
		if (
			!validPublicKey(publicKey) ||
			!validSignature(signature) ||
			!validNonce(challenge.nonce)
		)
			return null;
		const raw = decode(publicKey);
		const key = await crypto.subtle.importKey("raw", raw, algorithm, false, [
			"verify",
		]);
		const valid = await crypto.subtle.verify(
			signing,
			key,
			decode(signature),
			payload(challenge, token, profile, publicKey, purpose),
		);
		return valid ? fingerprint(raw) : null;
	} catch {
		return null;
	}
}

function transaction<T>(
	db: IDBDatabase,
	mode: IDBTransactionMode,
	operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const tx = db.transaction("keys", mode);
		const request = operation(tx.objectStore("keys"));
		tx.oncomplete = () => resolve(request.result);
		tx.onabort = () =>
			reject(
				tx.error ?? request.error ?? new Error("Could not save room identity."),
			);
		tx.onerror = () => {
			/* onabort reports the failed transaction */
		};
	});
}
const identities = new Map<string, Promise<RoomIdentity>>();

/** Private CryptoKeys remain non-exportable and local to this app's IndexedDB. */
export function getRoomIdentity(scope = "device"): Promise<RoomIdentity> {
	let identity = identities.get(scope);
	identity ??= (async () => {
		const db = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open("yumusic:room-identity:v1", 1);
			request.onupgradeneeded = () => request.result.createObjectStore("keys");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(
					new Error(
						"Could not open the local room identity. Check app storage permissions.",
					),
				);
		});
		try {
			let keys = await transaction<CryptoKeyPair | undefined>(
				db,
				"readonly",
				(store) => store.get(scope),
			);
			if (!keys) {
				const generated = await crypto.subtle.generateKey(algorithm, false, [
					"sign",
					"verify",
				]);
				try {
					await transaction(db, "readwrite", (store) =>
						store.add(generated, scope),
					);
					keys = generated;
				} catch (error) {
					// Two windows can race on first launch. Use the key that won the add.
					if (
						!(error instanceof DOMException) ||
						error.name !== "ConstraintError"
					)
						throw error;
					keys = await transaction<CryptoKeyPair | undefined>(
						db,
						"readonly",
						(store) => store.get(scope),
					);
				}
			}
			if (!keys) throw new Error("Could not load the room identity.");
			return fromKeys(keys);
		} finally {
			db.close();
		}
	})().catch((error) => {
		identities.delete(scope);
		throw error;
	});
	identities.set(scope, identity);
	return identity;
}
