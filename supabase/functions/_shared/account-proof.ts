export const validAccountId = (value: unknown): value is string =>
	typeof value === "string" &&
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

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
		!/^B[A-Za-z0-9+/]{86}=$/.test(publicKey) ||
		typeof signature !== "string" ||
		!/^[A-Za-z0-9+/]{86}==$/.test(signature) ||
		typeof issuedAt !== "number" ||
		!Number.isSafeInteger(issuedAt) ||
		Math.abs(now - issuedAt) > 300_000
	)
		return null;
	try {
		const raw = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
		const key = await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			{ name: "ECDSA", hash: "SHA-256" },
			key,
			Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
			accountBindingPayload(accountId, publicKey, issuedAt),
		);
		if (!valid) return null;
		return Array.from(
			new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
	} catch {
		return null;
	}
}
