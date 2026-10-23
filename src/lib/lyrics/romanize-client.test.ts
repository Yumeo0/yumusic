import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { RomanizeClient } from "./romanize-client";

class FakeWorker {
	onmessage:
		| ((event: { data: { id: number; lines: string[] } }) => void)
		| null = null;
	onerror: (() => void) | null = null;
	onmessageerror: (() => void) | null = null;
	terminated = false;
	messages: Array<{ id: number; lines: string[] }> = [];
	postMessage(message: { id: number; lines: string[] }) {
		this.messages.push(message);
	}
	terminate() {
		this.terminated = true;
	}
	answer(index = 0) {
		const message = this.messages[index];
		this.onmessage?.({ data: { ...message, lines: ["reading"] } });
	}
}

describe("romanization worker lifecycle", () => {
	test("shares concurrent work and unloads idle dictionaries", async () => {
		const workers: FakeWorker[] = [];
		const client = new RomanizeClient(() => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker as unknown as Worker;
		}, 5);
		const first = client.request(["一"]);
		const second = client.request(["二"]);
		expect(workers.length).toBe(1);
		workers[0].answer(0);
		expect(await first).toEqual(["reading"]);
		await delay(15);
		expect(workers[0].terminated).toBe(false);
		workers[0].answer(1);
		expect(await second).toEqual(["reading"]);
		await delay(15);
		expect(workers[0].terminated).toBe(true);
	});
	test("cancellation terminates unused work and later requests get a fresh worker", async () => {
		const workers: FakeWorker[] = [];
		const client = new RomanizeClient(() => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker as unknown as Worker;
		}, 5);
		const controller = new AbortController();
		const abandoned = client.request(["一"], controller.signal);
		controller.abort();
		expect(await abandoned).toEqual([]);
		expect(workers[0].terminated).toBe(true);
		const retried = client.request(["二"]);
		workers[1].onerror?.();
		expect(await retried).toEqual([]);
		expect(workers[1].terminated).toBe(true);
	});
});
