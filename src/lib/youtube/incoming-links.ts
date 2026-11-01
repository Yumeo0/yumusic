export const INCOMING_LINKS_EVENT = "yumusic-open-links";

/** Serialize queue reads so a new intent arriving during a read isn't missed. */
export function listenForIncomingLinks({
	events,
	take,
	receive,
	onError,
}: {
	events: EventTarget;
	take: () => Promise<string[]>;
	receive: (url: string) => void;
	onError: (error: unknown) => void;
}) {
	let stopped = false;
	let reading = false;
	let requested = false;
	const check = async () => {
		if (stopped) return;
		requested = true;
		if (reading) return;
		reading = true;
		try {
			do {
				requested = false;
				const links = await take();
				if (stopped) return;
				for (const link of links) receive(link);
			} while (requested && !stopped);
		} finally {
			reading = false;
		}
	};
	const refresh = () => void check().catch(onError);
	events.addEventListener(INCOMING_LINKS_EVENT, refresh);
	events.addEventListener("focus", refresh);
	// Let React's initial effect cleanup finish before consuming a cold-start
	// intent, so development StrictMode cannot consume and then discard it.
	const timer = setTimeout(refresh, 0);
	return () => {
		stopped = true;
		clearTimeout(timer);
		events.removeEventListener(INCOMING_LINKS_EVENT, refresh);
		events.removeEventListener("focus", refresh);
	};
}
