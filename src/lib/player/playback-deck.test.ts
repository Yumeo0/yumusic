import { expect, test } from "bun:test";
import { type Deck, waitForDeckData } from "./playback-deck";

function mountedDeck() {
	const media = Object.assign(new EventTarget(), {
		readyState: 0,
		error: null,
		pause: () => undefined,
		src: "",
	});
	const controller = new AbortController();
	const deck: Deck = {
		ref: { current: media as unknown as HTMLVideoElement },
		videoId: "abcdefghijk",
		mount: { controller, readiness: controller.signal },
		ready: false,
	};
	return { deck, media, controller };
}

test("track preparation waits for playable data on Android's canplay event", async () => {
	const { deck, media } = mountedDeck();
	let prepared = false;
	const pending = waitForDeckData(deck).then(() => {
		prepared = true;
	});
	media.readyState = 1;
	media.dispatchEvent(new Event("loadedmetadata"));
	await Promise.resolve();
	expect(prepared).toBe(false);
	media.readyState = 4;
	media.dispatchEvent(new Event("canplay"));
	await pending;
	expect(prepared).toBe(true);
});

test("a superseded preparation leaves the new deck mount alone", async () => {
	const { deck, controller } = mountedDeck();
	const pending = waitForDeckData(deck);
	const next = new AbortController();
	deck.mount = { controller: next, readiness: next.signal };
	controller.abort();
	await expect(pending).rejects.toHaveProperty("name", "AbortError");
	expect(next.signal.aborted).toBe(false);
});
