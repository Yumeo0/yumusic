import type { PeerOptions } from "peerjs";

/** Shared signaling and optional TURN configuration for rooms and account devices. */
export async function peerOptions(): Promise<PeerOptions> {
	const options: PeerOptions = { debug: 0 };
	const server = import.meta.env.VITE_LISTEN_PEER_SERVER;
	if (server) {
		const url = new URL(server);
		if (url.protocol !== "https:")
			throw new Error("The peer server must use HTTPS.");
		Object.assign(options, {
			host: url.hostname,
			port: Number(url.port || 443),
			path: url.pathname,
			secure: true,
		});
	}
	if (import.meta.env.VITE_LISTEN_ICE_URL) {
		const response = await fetch(import.meta.env.VITE_LISTEN_ICE_URL, {
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok)
			throw new Error("Could not load peer connection settings.");
		options.config = { iceServers: await response.json() };
	}
	return options;
}
