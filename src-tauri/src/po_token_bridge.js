(() => {
	const requests = new Map();
	let minter;
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	async function getMinter() {
		const deadline = Date.now() + 25000;
		while (Date.now() < deadline) {
			for (const key of Object.getOwnPropertyNames(window)) {
				let bridge;
				try {
					const value = Object.getOwnPropertyDescriptor(window, key)?.value;
					bridge = value && typeof value === "object" && value.bevasrs;
				} catch {
					// Cross-origin iframe WindowProxy objects reject property reads.
					continue;
				}
				if (typeof bridge?.wpc === "function") {
					const native = await bridge.wpc();
					await native.f();
					return native;
				}
			}
			await sleep(100);
		}
		throw new Error(
			"YouTube's PO minter did not become ready. Check YouTube consent and connectivity.",
		);
	}
	window.__yumusicMintPoToken = (id, binding, fallbackPath = "/?hl=en") => {
		if (requests.has(id)) return;
		requests.set(id, true);
		if (requests.size > 256) requests.delete(requests.keys().next().value);
		void (async () => {
			let result;
			const lightweightMint = window.__yumusicBgutilsMinter;
			try {
				if (lightweightMint) {
					result = { id, ...(await lightweightMint(binding)) };
				} else {
					minter ??= getMinter().catch((error) => {
						minter = undefined;
						throw error;
					});
					const native = await minter;
					const token = await native.mws({ c: binding, mc: false, me: false });
					const context = window.ytcfg?.get("INNERTUBE_CONTEXT");
					result = {
						id,
						token,
						context,
						accountIndex: Number(window.ytcfg?.get("SESSION_INDEX") ?? 0),
					};
				}
				if (!result.token || !result.context?.client?.visitorData)
					throw new Error("YouTube returned an incomplete PO session");
				result.context = JSON.parse(JSON.stringify(result.context));
				result.context.client.userAgent = navigator.userAgent;
			} catch (error) {
				if (lightweightMint) {
					// The existing page can handle an interactive consent prompt. The
					// native caller retries the same request after navigation.
					window.location.replace(fallbackPath);
					return;
				}
				result = {
					id,
					error: error instanceof Error ? error.message : "PO minting failed",
				};
			}
			window.location.href =
				"yumusic-po://result/?payload=" +
				encodeURIComponent(JSON.stringify(result));
		})();
	};
})();
