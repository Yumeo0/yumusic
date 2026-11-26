export const validAccountId = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export const DEVICE_KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
export const DEVICE_SIGNATURE_ALGORITHM = { name: "ECDSA", hash: "SHA-256" };

export const validPublicKey = (value: unknown): value is string =>
	typeof value === "string" && /^B[A-Za-z0-9+/]{86}=$/.test(value);
export const validSignature = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(value);
export const validFingerprint = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const decode = (value: string) =>
	Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

export async function fingerprintDeviceKey(bytes: Uint8Array<ArrayBuffer>) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function verifyDeviceSignature(
	publicKey: string,
	signature: unknown,
	message: Uint8Array<ArrayBuffer>,
): Promise<string | null> {
	if (!validPublicKey(publicKey) || !validSignature(signature)) return null;
	try {
		const raw = decode(publicKey);
		const key = await crypto.subtle.importKey(
			"raw",
			raw,
			DEVICE_KEY_ALGORITHM,
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			DEVICE_SIGNATURE_ALGORITHM,
			key,
			decode(signature),
			message,
		);
		return valid ? await fingerprintDeviceKey(raw) : null;
	} catch {
		return null;
	}
}

export function accountBindingPayload(
	accountId: string,
	publicKey: string,
	issuedAt: number,
) {
	return new TextEncoder().encode(
		JSON.stringify([
			"yumusic-account-device-v1",
			accountId,
			publicKey,
			issuedAt,
		]),
	);
}

export async function verifyAccountBinding(
	accountId: string,
	publicKey: unknown,
	issuedAt: unknown,
	signature: unknown,
	now = Date.now(),
): Promise<string | null> {
	if (
		!validAccountId(accountId) ||
		typeof publicKey !== "string" ||
		typeof issuedAt !== "number" ||
		!Number.isSafeInteger(issuedAt) ||
		Math.abs(now - issuedAt) > 300_000
	)
		return null;
	return verifyDeviceSignature(
		publicKey,
		signature,
		accountBindingPayload(accountId, publicKey, issuedAt),
	);
}
