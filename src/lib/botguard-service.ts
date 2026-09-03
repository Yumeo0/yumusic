import { BotGuardClient, parseChallengeData } from "bgutils-js/botguard";
import type {
	IBotguardClientSideBgChallenge,
	WebPoSignalOutput,
} from "bgutils-js/shared-types";
import { buildURL, GOOG_API_KEY } from "bgutils-js/utils";
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
	 * Minted po tokens per identifier (visitor data). Running the BotGuard
	 * program is expensive — seconds of blocking JS on phones — and a token
	 * is bound to its identifier, not to a single playback, so one mint per
	 * identifier is enough for the whole session.
	 */
	private readonly mintedTokens = new Map<string, string>();

	async init() {
		if (this.initializationPromise) {
			return await this.initializationPromise;
		}

		return this.setup();
	}

	private async setup() {
		if (this.initializationPromise) return await this.initializationPromise;

		this.initializationPromise = this._initBotguard();

		try {
			this.botguardClient = await this.initializationPromise;
			return this.botguardClient;
		} finally {
			this.initializationPromise = null;
		}
	}

	private async _initBotguard() {
		const challengeResponse = await fetch(buildURL("Create", true), {
			method: "POST",
			headers: {
				"content-type": "application/json+protobuf",
				"x-goog-api-key": GOOG_API_KEY,
				"x-user-agent": "grpc-web-javascript/0.1",
			},
			body: JSON.stringify([this.waaRequestKey]),
		});

		const challengeResponseData = await challengeResponse.json();
		this.bgChallenge = parseChallengeData(challengeResponseData);

		if (!this.bgChallenge) return;

		const interpreterJavascript =
			this.bgChallenge.interpreterJavascript
				?.privateDoNotAccessOrElseSafeScriptWrappedValue;

		if (!interpreterJavascript) {
			console.error(
				"[BotguardService]",
				"Could not get interpreter javascript. Interpreter Hash:",
				this.bgChallenge.interpreterHash,
			);
			return;
		}

		if (this.bgChallenge.interpreterHash) {
			if (!document.getElementById(this.bgChallenge.interpreterHash)) {
				const script = document.createElement("script");
				script.type = "text/javascript";
				script.id = this.bgChallenge.interpreterHash;
				script.textContent = interpreterJavascript;
				document.head.appendChild(script);
			}
		}

		this.botguardClient = await BotGuardClient.create({
			globalObject: globalThis,
			globalName: this.bgChallenge.globalName,
			program: this.bgChallenge.program,
		});

		if (this.bgChallenge) {
			const webPoSignalOutput: WebPoSignalOutput = [];
			const botguardResponse = await this.botguardClient.snapshot({
				webPoSignalOutput,
			});

			const integrityTokenResponse = await fetchFunction(
				buildURL("GenerateIT", true),
				{
					method: "POST",
					headers: {
						"content-type": "application/json+protobuf",
						"x-goog-api-key": GOOG_API_KEY,
						"x-user-agent": "grpc-web-javacript/0.1",
					},
					body: JSON.stringify([this.waaRequestKey, botguardResponse]),
				},
			);

			const integrityTokenResponseData = await integrityTokenResponse.json();
			const integrityToken = integrityTokenResponseData[0] as
				| string
				| undefined;

			if (!integrityToken) {
				console.error(
					"[BotguardService]",
					"Could not get integrity token. Interpreter Hash:",
					this.bgChallenge.interpreterHash,
				);
				return;
			}

			this.integrityTokenBasedMinter = await WebPoMinter.create(
				{ integrityToken },
				webPoSignalOutput,
			);
		}

		return this.botguardClient;
	}

	public mintColdStartToken(contentBinding: string) {
		return createColdStartToken(contentBinding);
	}

	public async mintToken(identifier: string): Promise<string> {
		const cached = this.mintedTokens.get(identifier);
		if (cached) return cached;

		await this.init();

		const token = this.integrityTokenBasedMinter
			? await this.integrityTokenBasedMinter.mintAsWebsafeString(identifier)
			: createColdStartToken(identifier);
		this.mintedTokens.set(identifier, token);
		return token;
	}

	public isInitialized() {
		return !!this.botguardClient && !!this.integrityTokenBasedMinter;
	}

	public dispose() {
		this.mintedTokens.clear();
		if (this.botguardClient && this.bgChallenge) {
			void this.botguardClient.shutdown();
			this.botguardClient = undefined;
			this.integrityTokenBasedMinter = undefined;

			const script = this.bgChallenge.interpreterHash
				? document.getElementById(this.bgChallenge.interpreterHash)
				: undefined;
			if (script) {
				script.remove();
			}
		}
	}

	public async reinit() {
		if (this.initializationPromise) return this.initializationPromise;
		this.dispose();
		return this.setup();
	}
}

export const botguardService = new BotguardService();
