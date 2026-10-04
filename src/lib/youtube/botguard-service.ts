import { BotGuardClient } from "bgutils-js/botguard";
import type {
	IBotguardClientSideBgChallenge,
	WebPoSignalOutput,
} from "bgutils-js/shared-types";
import {
	buildURL,
	getHeaders,
	parseLooseJSON,
	USER_AGENT,
} from "bgutils-js/utils";
import { createColdStartToken, WebPoMinter } from "bgutils-js/webpo";
import { fetchFunction } from "./youtube-client";

export class BotguardService {
	private readonly waaRequestKey = "O43z0dpjhgX20SCx4KAo";

	public botguardClient?: BotGuardClient;
	public initializationPromise?: Promise<BotGuardClient | undefined> | null =
		null;
	public integrityTokenBasedMinter?: WebPoMinter;
	public bgChallenge?: IBotguardClientSideBgChallenge;
	/**
	 * Ready-to-use WS token YouTube hands back when it issues no integrity
	 * token (valid ~12h). Used as the PoToken until a minter is available.
	 */
	public websafeFallbackToken?: string;

	async init() {
		// Already have a working token source: don't redo the expensive setup
		// (the initializer used to be re-run on every mint).
		if (this.integrityTokenBasedMinter || this.websafeFallbackToken) {
			return this.botguardClient;
		}
		if (this.initializationPromise) {
			return await this.initializationPromise;
		}

		return this.setup();
	}

	private async setup() {
		if (this.initializationPromise) return await this.initializationPromise;

		this.initializationPromise = this._initBotguard().catch((error) => {
			// Degrade to a cold-start token instead of blocking playback.
			console.error("[BotguardService] initialization failed:", error);
			return undefined;
		});

		try {
			this.botguardClient = await this.initializationPromise;
			return this.botguardClient;
		} finally {
			this.initializationPromise = null;
		}
	}

	private async _initBotguard() {
		// The legacy /api/jnn/v1/Create endpoint now hands out challenges whose
		// tokens go stale almost immediately (playback dies around the first
		// minute). Use the attestation challenge youtube.com embeds in its page
		// instead — that is what the current web client does.
		const pageResponse = await fetchFunction("https://www.youtube.com", {
			headers: {
				accept: "*/*",
				"accept-language": "en-US,en;q=0.7",
				"user-agent": USER_AGENT,
			},
		});
		if (!pageResponse.ok) {
			throw new Error(`Failed to fetch YouTube page: ${pageResponse.status}`);
		}
		const pageHtml = await pageResponse.text();

		const ytConfig = pageHtml.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
		if (!ytConfig) throw new Error("Could not find ytcfg in page HTML");
		// The VM reads EVENT_ID from the page config.
		(globalThis as unknown as { yt: unknown }).yt = {
			config_: JSON.parse(ytConfig),
		};

		const attestation = pageHtml.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/);
		if (!attestation) {
			throw new Error("Could not find challenge in page HTML");
		}
		const attestationData = parseLooseJSON(attestation[1]);
		const challenge = (
			attestationData.R as { bgChallenge?: IBotguardClientSideBgChallenge }
		)?.bgChallenge;
		if (!challenge) throw new Error("Could not get challenge");
		this.bgChallenge = challenge;

		const interpreterUrl =
			challenge.interpreterUrl
				?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
		if (!interpreterUrl) throw new Error("Could not get interpreter URL");

		const scriptResponse = await fetchFunction(`https:${interpreterUrl}`);
		if (!scriptResponse.ok) {
			throw new Error(`Failed to fetch BotGuard VM: ${scriptResponse.status}`);
		}
		const interpreterJavascript = await scriptResponse.text();
		if (!interpreterJavascript) throw new Error("Could not load BotGuard VM");
		new Function(interpreterJavascript)();

		this.botguardClient = await BotGuardClient.create({
			program: challenge.program,
			globalName: challenge.globalName,
			globalObject: globalThis,
		});

		const webPoSignalOutput: WebPoSignalOutput = [];
		const botguardResponse = await this.botguardClient.snapshot({
			webPoSignalOutput,
		});

		const integrityTokenResponse = await fetchFunction(
			buildURL("GenerateIT", true),
			{
				method: "POST",
				headers: getHeaders(),
				body: JSON.stringify([this.waaRequestKey, botguardResponse]),
			},
		);
		const integrityTokenJson = (await integrityTokenResponse.json()) as [
			string,
			number,
			number,
			string,
		];
		const [
			integrityToken,
			estimatedTtlSecs,
			mintRefreshThreshold,
			websafeFallbackToken,
		] = integrityTokenJson;

		if (integrityToken) {
			this.integrityTokenBasedMinter = await WebPoMinter.create(
				{
					integrityToken,
					estimatedTtlSecs,
					mintRefreshThreshold,
					websafeFallbackToken,
				},
				webPoSignalOutput,
			);
		} else if (websafeFallbackToken) {
			// No integrity token (e.g. the attestation is not trusted), but the
			// server did issue a ready-to-use fallback token.
			this.websafeFallbackToken = websafeFallbackToken;
		} else {
			throw new Error("Could not get integrity token");
		}

		return this.botguardClient;
	}

	public mintColdStartToken(contentBinding: string) {
		return createColdStartToken(contentBinding);
	}

	public async mintToken(identifier: string): Promise<string> {
		await this.init();

		if (this.integrityTokenBasedMinter) {
			return await this.integrityTokenBasedMinter.mintAsWebsafeString(
				identifier,
			);
		}
		if (this.websafeFallbackToken) return this.websafeFallbackToken;
		return createColdStartToken(identifier);
	}

	public isInitialized() {
		return (
			!!this.botguardClient &&
			(!!this.integrityTokenBasedMinter || !!this.websafeFallbackToken)
		);
	}

	public dispose() {
		if (this.botguardClient) {
			void this.botguardClient.shutdown();
			this.botguardClient = undefined;
			this.integrityTokenBasedMinter = undefined;
			this.bgChallenge = undefined;
			this.websafeFallbackToken = undefined;
		}
	}

	public async reinit() {
		if (this.initializationPromise) return this.initializationPromise;
		this.dispose();
		return this.setup();
	}
}

export const botguardService = new BotguardService();
