import { validAccountId } from "../../../supabase/functions/_shared/account-proof";
import { SUPABASE_URL, supabase } from "../sync/client";
import { matchesYouTubeAccount } from "../sync/youtube-account";
import { getRoomIdentity } from "./identity";

export async function resolveDeviceAccount(
	fingerprint: string,
): Promise<string | null> {
	try {
		const response = await fetch(
			`${SUPABASE_URL}/functions/v1/room-identity?fingerprint=${encodeURIComponent(fingerprint)}`,
			{ signal: AbortSignal.timeout(5000) },
		);
		if (!response.ok) return null;
		const data = await response.json();
		return validAccountId(data.accountId) ? data.accountId : null;
	} catch {
		return null;
	}
}

export async function getLinkedRoomIdentity() {
	const {
		data: { session },
		error,
	} = await supabase.auth.getSession();
	if (error) throw error;
	if (!session || !matchesYouTubeAccount(session.user))
		return getRoomIdentity();
	const identity = await getRoomIdentity(`account:${session.user.id}`);
	const issuedAt = Date.now();
	if (!identity.bindAccount)
		throw new Error("Device does not support account linking.");
	const signature = await identity.bindAccount(session.user.id, issuedAt);
	const result = await supabase.functions.invoke("room-identity", {
		body: { publicKey: identity.publicKey, issuedAt, signature },
	});
	if (
		result.error ||
		result.data?.accountId !== session.user.id ||
		result.data?.fingerprint !== identity.fingerprint
	)
		throw new Error(
			"Could not link this device to your sync account. Check your connection and try again.",
		);
	return { ...identity, accountId: session.user.id };
}

export async function unlinkRoomIdentity() {
	const {
		data: { session },
	} = await supabase.auth.getSession();
	if (!session) return;
	const identity = await getRoomIdentity(`account:${session.user.id}`);
	const { error } = await supabase.functions.invoke("room-identity", {
		method: "DELETE",
		body: { fingerprint: identity.fingerprint },
	});
	if (error)
		throw new Error(
			"Could not unlink this device. Connect to the internet and try signing out again.",
		);
}
