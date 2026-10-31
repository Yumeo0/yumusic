import { describe, expect, test } from "bun:test";
import {
	createNonce,
	generateRoomIdentity,
	validPublicKey,
	validSignature,
	verifyIdentity,
} from "./identity";

const profile = { username: "Friend", avatar: null };
const challenge = () => ({
	nonce: createNonce(),
	session: "room",
	host: "host",
	guest: "guest",
});
describe("signed room identities", () => {
	test("peer-trust proofs cannot be reused as room-join proofs", async () => {
		const identity = await generateRoomIdentity();
		const c = challenge();
		const signature = await identity.sign(c, "invite", profile, "trust");
		expect(
			await verifyIdentity(
				identity.publicKey,
				c,
				"invite",
				profile,
				signature,
				"trust",
			),
		).toBe(identity.fingerprint);
		expect(
			await verifyIdentity(identity.publicKey, c, "invite", profile, signature),
		).toBeNull();
	});
	test("verifies possession of a non-exported private key", async () => {
		const identity = await generateRoomIdentity();
		const c = challenge();
		const signature = await identity.sign(c, "invite", profile);
		expect(validPublicKey(identity.publicKey)).toBe(true);
		expect(validSignature(signature)).toBe(true);
		expect(
			await verifyIdentity(identity.publicKey, c, "invite", profile, signature),
		).toBe(identity.fingerprint);
	});
	test("a copied public key cannot be used with someone else's signature", async () => {
		const friend = await generateRoomIdentity();
		const impostor = await generateRoomIdentity();
		const c = challenge();
		const signature = await impostor.sign(c, "invite", profile);
		expect(
			await verifyIdentity(friend.publicKey, c, "invite", profile, signature),
		).toBeNull();
		expect(friend.fingerprint).not.toBe(impostor.fingerprint);
	});
	test("proofs cannot be replayed for a new challenge, room, routing ID, invite or profile", async () => {
		const identity = await generateRoomIdentity();
		const c = challenge();
		const signature = await identity.sign(c, "invite", profile);
		for (const altered of [
			{ ...c, nonce: createNonce() },
			{ ...c, session: "other-room" },
			{ ...c, host: "other-host" },
			{ ...c, guest: "other-guest" },
		]) {
			expect(
				await verifyIdentity(
					identity.publicKey,
					altered,
					"invite",
					profile,
					signature,
				),
			).toBeNull();
		}
		expect(
			await verifyIdentity(
				identity.publicKey,
				c,
				"other-invite",
				profile,
				signature,
			),
		).toBeNull();
		expect(
			await verifyIdentity(
				identity.publicKey,
				c,
				"invite",
				{ ...profile, username: "Changed" },
				signature,
			),
		).toBeNull();
	});
	test("malformed key points and signatures fail closed", async () => {
		const c = challenge();
		expect(
			await verifyIdentity("bad-key", c, "invite", profile, "bad-signature"),
		).toBeNull();
		expect(
			await verifyIdentity(
				`B${"A".repeat(86)}=`,
				c,
				"invite",
				profile,
				`${"A".repeat(86)}==`,
			),
		).toBeNull();
	});
});
