import { expect, test } from "bun:test";
import { acquireCamera, waitForCameraForeground } from "./camera";

test("scanner resumes when the permission prompt's hidden document becomes visible", async () => {
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const page = Object.assign(new EventTarget(), { hidden: true });
	const view = new EventTarget();
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: page,
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: view,
	});
	try {
		let resumed = false;
		const ready = waitForCameraForeground(new AbortController().signal).then(
			() => {
				resumed = true;
			},
		);
		view.dispatchEvent(new Event("focus"));
		await Promise.resolve();
		expect(resumed).toBe(false);
		page.hidden = false;
		page.dispatchEvent(new Event("visibilitychange"));
		await ready;
		expect(resumed).toBe(true);
		const controller = new AbortController();
		page.hidden = true;
		const closed = waitForCameraForeground(controller.signal);
		controller.abort();
		await expect(closed).rejects.toThrow("Scanner closed");
	} finally {
		if (previousDocument)
			Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
		if (previousWindow)
			Object.defineProperty(globalThis, "window", previousWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
});

test("permission-granted camera waits for the app to resume and is reused", async () => {
	let foreground!: () => void;
	let stopped = 0;
	const stream = {
		getTracks: () => [{ stop: () => stopped++ }],
	} as unknown as MediaStream;
	const controller = new AbortController();
	let ready = false;
	const pending = acquireCamera(
		async () => stream,
		() =>
			new Promise<void>((resolve) => {
				foreground = resolve;
			}),
		controller.signal,
	).then((value) => {
		ready = true;
		return value;
	});
	await Promise.resolve();
	expect(ready).toBe(false);
	foreground();
	expect(await pending).toBe(stream);
	expect(stopped).toBe(0);
	controller.abort();
	expect(stopped).toBe(1);
});

test("closing during the permission prompt releases the late camera stream", async () => {
	let allow!: (stream: MediaStream) => void;
	let stopped = 0;
	const controller = new AbortController();
	const pending = acquireCamera(
		() =>
			new Promise<MediaStream>((resolve) => {
				allow = resolve;
			}),
		async () => undefined,
		controller.signal,
	);
	controller.abort();
	allow({
		getTracks: () => [{ stop: () => stopped++ }],
	} as unknown as MediaStream);
	await expect(pending).rejects.toThrow("Scanner closed");
	expect(stopped).toBe(1);
});
