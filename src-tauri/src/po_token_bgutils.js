import { BotGuardClient } from "bgutils-js/botguard";
import { buildURL, getHeaders, parseLooseJSON } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const INTERPRETER_ORIGINS = new Set([
	YOUTUBE_ORIGIN,
	"https://www.google.com",
	"https://www.gstatic.com",
]);
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";

function loadInterpreter(address, signal) {
	signal.throwIfAborted();
	const script = document.createElement("script");
	script.src = address.href;
	const loaded = new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		script.onload = () => {
			signal.removeEventListener("abort", abort);
			resolve();
		};
		script.onerror = () => {
			signal.removeEventListener("abort", abort);
			reject(new Error("Could not load the Google challenge interpreter"));
		};
		document.head.append(script);
	});
	return loaded.finally(() => script.remove());
}

async function createSession() {
	const signal = AbortSignal.timeout(10_000);
	// The text document provides the real YouTube origin without rendering the
	// homepage. Fetch the challenge and visitor context in this same session.
	const page = await fetch("/?hl=en", { mode: "same-origin", signal });
	if (!page.ok) throw new Error("Could not fetch the YouTube challenge");
	const html = await page.text();
	const configJson = html.match(/ytcfg\.set\(({.+?})\);/s)?.[1];
	const challengeJson = html.match(/window\.ytAtN\(\s*({[\s\S]*?})\s*\)/)?.[1];
	if (!configJson || !challengeJson) {
		throw new Error("YouTube challenge configuration is unavailable");
	}
	const config = JSON.parse(configJson);
	const context = config.INNERTUBE_CONTEXT;
	const challenge = parseLooseJSON(challengeJson).R?.bgChallenge;
	const interpreter =
		challenge?.interpreterUrl
			?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
	if (!context?.client?.visitorData || !challenge?.program || !interpreter) {
		throw new Error("YouTube challenge configuration is incomplete");
	}

	const address = new URL(interpreter, YOUTUBE_ORIGIN);
	if (!INTERPRETER_ORIGINS.has(address.origin)) {
		throw new Error("Unexpected Google challenge interpreter origin");
	}
	window.yt = { config_: config };
	await loadInterpreter(address, signal);

	const botguard = await BotGuardClient.create({
		program: challenge.program,
		globalName: challenge.globalName,
		globalObject: window,
	});
	try {
		const webPoSignalOutput = [];
		const snapshot = await botguard.snapshot({ webPoSignalOutput }, 8_000);
		const headers = new Headers(getHeaders());
		headers.delete("user-agent");
		const response = await fetch(buildURL("GenerateIT", true), {
			method: "POST",
			headers,
			body: JSON.stringify([REQUEST_KEY, snapshot]),
			signal,
		});
		if (!response.ok) throw new Error("Google attestation request failed");
		const [integrityToken, estimatedTtlSecs, mintRefreshThreshold] =
			await response.json();
		if (!integrityToken)
			throw new Error("Google did not issue an integrity token");
		const ttlSeconds = Number(estimatedTtlSecs);
		const expiresAt =
			ttlSeconds > 0 ? Date.now() + ttlSeconds * 1_000 : Infinity;
		const minter = await WebPoMinter.create(
			{ integrityToken, estimatedTtlSecs, mintRefreshThreshold },
			webPoSignalOutput,
		);
		return {
			botguard,
			minter,
			context,
			accountIndex: Number(config.SESSION_INDEX ?? 0),
			expiresAt,
		};
	} catch (error) {
		void botguard.shutdown().catch(() => undefined);
		throw error;
	}
}

if (location.origin === YOUTUBE_ORIGIN && location.pathname === "/robots.txt") {
	let session;
	window.__yumusicBgutilsMinter = async (binding) => {
		session ??= createSession();
		const previous = session;
		const current = await previous;
		if (session === previous && Date.now() >= current.expiresAt) {
			session = current.botguard
				.shutdown(1_000)
				.catch(() => undefined)
				.then(createSession);
		}
		const { minter, context, accountIndex } = await session;
		return {
			token: await minter.mintAsWebsafeString(binding),
			context,
			accountIndex,
		};
	};
}
