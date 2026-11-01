import { expect, test } from "bun:test";
import { verifyAccountBinding } from "../../../supabase/functions/_shared/account-proof";
import { generateRoomIdentity } from "./identity";
import { validTrustKey } from "./join-settings";

test("account binding requires the private key and is bound to account and timestamp", async () => {
	const identity = await generateRoomIdentity();
	const account = "11111111-1111-4111-8111-111111111111";
	const now = Date.now();
	const signature = await identity.bindAccount?.(account, now);
	expect(
		await verifyAccountBinding(account, identity.publicKey, now, signature),
	).toBe(identity.fingerprint);
	expect(
		await verifyAccountBinding(
			"22222222-2222-4222-8222-222222222222",
			identity.publicKey,
			now,
			signature,
		),
	).toBeNull();
	expect(
		await verifyAccountBinding(account, identity.publicKey, now + 1, signature),
	).toBeNull();
	expect(
		await verifyAccountBinding(
			account,
			identity.publicKey,
			now,
			signature,
			now + 300_001,
		),
	).toBeNull();
	const imposter = await generateRoomIdentity();
	expect(
		await verifyAccountBinding(
			account,
			identity.publicKey,
			now,
			await imposter.bindAccount?.(account, now),
		),
	).toBeNull();
});

test("trust keys accept verified account IDs and retain legacy device fingerprints", () => {
	expect(validTrustKey("account:11111111-1111-4111-8111-111111111111")).toBe(
		true,
	);
	expect(validTrustKey("a".repeat(64))).toBe(true);
	expect(validTrustKey("account:display-name")).toBe(false);
	expect(validTrustKey("account:someone@example.com")).toBe(false);
});
