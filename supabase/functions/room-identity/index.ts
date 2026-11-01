import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { verifyAccountBinding } from "../_shared/account-proof.ts";

const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers":
		"authorization, apikey, content-type, x-client-info",
	"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
	"Cache-Control": "no-store",
};
const reply = (status: number, value: unknown) =>
	Response.json(value, { status, headers: cors });
// biome-ignore lint/correctness/noUndeclaredVariables: Supabase Edge runtime global.
const projectUrl = Deno.env.get("SUPABASE_URL");
// biome-ignore lint/correctness/noUndeclaredVariables: Supabase Edge runtime global.
const serverKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!projectUrl || !serverKey)
	throw new Error("Missing Supabase runtime configuration");
const admin = createClient(projectUrl, serverKey, {
	auth: { persistSession: false, autoRefreshToken: false },
});

// biome-ignore lint/correctness/noUndeclaredVariables: Supabase Edge runtime global.
Deno.serve(async (request: Request) => {
	if (request.method === "OPTIONS")
		return new Response(null, { headers: cors });
	try {
		if (request.method === "GET") {
			// A targeted lookup reveals only an opaque account ID for a known
			// public key fingerprint. Never expose a directory, emails or tokens.
			const fingerprint = new URL(request.url).searchParams.get("fingerprint");
			if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint))
				return reply(400, { error: "Invalid fingerprint" });
			const { data, error } = await admin
				.from("room_devices")
				.select("user_id")
				.eq("fingerprint", fingerprint)
				.maybeSingle();
			if (error) return reply(503, { error: "Identity lookup unavailable" });
			return reply(200, { accountId: data?.user_id ?? null });
		}
		if (request.method !== "POST" && request.method !== "DELETE")
			return reply(405, { error: "Method not allowed" });
		const authorization = request.headers.get("Authorization") ?? "";
		if (!authorization.startsWith("Bearer "))
			return reply(401, { error: "Sign in required" });
		const {
			data: { user },
			error: authError,
		} = await admin.auth.getUser(authorization.slice(7));
		if (authError || !user) return reply(401, { error: "Sign in required" });
		const body = await request.text();
		if (body.length > 4096) return reply(413, { error: "Request too large" });
		const input = JSON.parse(body);
		if (request.method === "DELETE") {
			if (
				typeof input.fingerprint !== "string" ||
				!/^[a-f0-9]{64}$/.test(input.fingerprint)
			)
				return reply(400, { error: "Invalid fingerprint" });
			const { error } = await admin
				.from("room_devices")
				.delete()
				.eq("fingerprint", input.fingerprint)
				.eq("user_id", user.id);
			return error
				? reply(503, { error: "Could not unlink device" })
				: reply(200, { unlinked: true });
		}
		const fingerprint = await verifyAccountBinding(
			user.id,
			input.publicKey,
			input.issuedAt,
			input.signature,
		);
		if (!fingerprint)
			return reply(400, { error: "Device ownership could not be verified" });
		// Ignore duplicate registrations, then check ownership. Never move an
		// existing key between accounts, even for another signed-in caller.
		const { error } = await admin
			.from("room_devices")
			.upsert(
				{ fingerprint, user_id: user.id },
				{ onConflict: "fingerprint", ignoreDuplicates: true },
			);
		if (error) return reply(503, { error: "Could not link device" });
		const existing = await admin
			.from("room_devices")
			.select("user_id")
			.eq("fingerprint", fingerprint)
			.single();
		if (existing.error)
			return reply(503, { error: "Could not verify device link" });
		if (existing.data.user_id !== user.id)
			return reply(409, { error: "Device key belongs to another account" });
		return reply(200, { accountId: user.id, fingerprint });
	} catch {
		return reply(400, { error: "Invalid identity request" });
	}
});
