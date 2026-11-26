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
	private waiting: { background: boolean; run: () => Promise<void> }[] = [];
	private minting = false;
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

	async preparePlayback(
		client: Innertube,
		videoId: string,
		signal?: AbortSignal,
		background = false,
	): Promise<string> {
		const proof = await this.getPlaybackProof(videoId, signal, background);
		signal?.throwIfAborted();
		// A token minted in a different anonymous visitor session is not usable.
		client.session.context = structuredClone(proof.context);
		client.session.account_index = proof.accountIndex;
		return proof.token;
	}

	async getPlaybackProof(
		binding: string,
		signal?: AbortSignal,
		background = false,
	): Promise<PlaybackProof> {
		if (!binding)
			throw new Error("A video binding is required for playback attestation");
		signal?.throwIfAborted();
		return new Promise((resolve, reject) => {
			const abort = () => reject(signal?.reason);
			signal?.addEventListener("abort", abort, { once: true });
			this.waiting.push({
				background,
				run: async () => {
					try {
						signal?.throwIfAborted();
						const proof = await this.mintProof(binding);
						signal?.throwIfAborted();
						if (!proof.token || !proof.context?.client?.visitorData) {
							throw new Error(
								"YouTube did not return a ready playback attestation",
							);
						}
						this.proof = proof;
						resolve(proof);
					} catch (error) {
						reject(error);
					} finally {
						signal?.removeEventListener("abort", abort);
					}
				},
			});
			void this.drain();
		});
	}

	private async drain() {
		if (this.minting) return;
		this.minting = true;
		// Keep one native call outstanding so playback can go ahead of queued downloads.
		while (this.waiting.length) {
			const foreground = this.waiting.findIndex(
				(request) => !request.background,
			);
			const [request] = this.waiting.splice(Math.max(0, foreground), 1);
			await request.run();
		}
		this.minting = false;
	}
}

export const botguardService = new BotguardService();
