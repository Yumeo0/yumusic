import { expect, test } from "bun:test";
import { INCOMING_LINKS_EVENT, listenForIncomingLinks } from "./incoming-links";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("cold-start delivery waits until the active listener survives effect cleanup", async () => {
	const events = new EventTarget();
	const queue = ["https://music.youtube.com/@_yumeo_"];
	const received: string[] = [];
	let reads = 0;
	const options = {
		events,
		take: async () => {
			reads++;
			return queue.splice(0);
		},
		receive: (url: string) => received.push(url),
		onError: (error: unknown) => {
			throw error;
		},
	};
	const discard = listenForIncomingLinks(options);
	discard();
	const stop = listenForIncomingLinks(options);
	await tick();
	expect(reads).toBe(1);
	expect(received).toEqual(["https://music.youtube.com/@_yumeo_"]);
	stop();
});

test("an intent arriving during a queue read triggers another read without duplicate delivery", async () => {
	const events = new EventTarget();
	const received: string[] = [];
	let finish: (urls: string[]) => void = () => {
		throw new Error("Read hasn't started");
	};
	let reads = 0;
	const stop = listenForIncomingLinks({
		events,
		take: () =>
			++reads === 1
				? new Promise<string[]>((resolve) => {
						finish = resolve;
					})
				: Promise.resolve(["second"]),
		receive: (url) => received.push(url),
		onError: (error) => {
			throw error;
		},
	});
	await tick();
	events.dispatchEvent(new Event(INCOMING_LINKS_EVENT));
	finish(["first"]);
	await tick();
	expect(reads).toBe(2);
	expect(received).toEqual(["first", "second"]);
	stop();
	events.dispatchEvent(new Event(INCOMING_LINKS_EVENT));
	await tick();
	expect(reads).toBe(2);
});
