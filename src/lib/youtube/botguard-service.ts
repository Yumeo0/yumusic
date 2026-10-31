import { invoke } from "@tauri-apps/api/core";
import type { Innertube } from "youtubei.js/web";

export interface PlaybackProof {
	token: string;
	context: Innertube["session"]["context"];
	accountIndex: number;
	cookie: string;
}

type MintProof = (binding: string) => Promise<PlaybackProof>;

/** Uses the same ready native minter as the successful PO reuse probe. */
export class BotguardService {
	private proof?: PlaybackProof;
	constructor(
		private readonly mintProof: MintProof = (binding) =>
			invoke<PlaybackProof>("mint_po_token", { binding }),
	) {}

	get playbackCookie() {
		return this.proof?.cookie;
	}

	get playbackUserAgent() {
		return this.proof?.context.client.userAgent;
	}

	async preparePlayback(client: Innertube, videoId: string): Promise<string> {
		const proof = await this.mint(videoId);
		// A token minted in a different anonymous visitor session is not usable.
		client.session.context = structuredClone(proof.context);
		client.session.account_index = proof.accountIndex;
		return proof.token;
	}

	private async mint(binding: string) {
		if (!binding)
			throw new Error("A video binding is required for playback attestation");
		const proof = await this.mintProof(binding);
		if (!proof.token || !proof.context?.client?.visitorData) {
			throw new Error("YouTube did not return a ready playback attestation");
		}
		this.proof = proof;
		return proof;
	}

	async mintToken(videoId: string): Promise<string> {
		return (await this.mint(videoId)).token;
	}
}

export const botguardService = new BotguardService();
