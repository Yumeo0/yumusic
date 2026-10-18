import { beforeEach, describe, expect, test } from "bun:test";
import {
	dismissToast,
	showToast,
	subscribeToasts,
	type ToastItem,
	updateToast,
} from "./toast";

/** Pending auto-dismiss timers, fired manually via runTimers(). */
const timers = new Map<number, () => void>();
let nextTimer = 0;
/** Latest snapshot pushed by the store. */
let visible: ToastItem[] = [];

/** Minimal window stub the toast store touches. */
function installBrowserStubs() {
	timers.clear();
	nextTimer = 0;
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		writable: true,
		value: {
			setTimeout: (callback: () => void) => {
				nextTimer += 1;
				timers.set(nextTimer, callback);
				return nextTimer;
			},
			clearTimeout: (id: number) => {
				timers.delete(id);
			},
		},
	});
}

function runTimers() {
	const callbacks = [...timers.values()];
	timers.clear();
	for (const callback of callbacks) callback();
}

subscribeToasts((toasts) => {
	visible = toasts;
});

beforeEach(() => {
	installBrowserStubs();
	for (const toast of visible) dismissToast(toast.id);
});

describe("showToast", () => {
	test("auto-dismisses after the default delay", () => {
		showToast("Link copied");
		expect(visible.map((toast) => toast.message)).toEqual(["Link copied"]);

		runTimers();

		expect(visible).toEqual([]);
	});

	test("stays on screen until dismissed when durationMs is null", () => {
		const id = showToast("Installing…", { durationMs: null });

		runTimers();
		expect(visible).toHaveLength(1);

		dismissToast(id);
		expect(visible).toEqual([]);
	});

	test("keeps a click handler for the whole toast lifetime", () => {
		let clicks = 0;
		const id = showToast("Update available", {
			durationMs: null,
			onClick: () => {
				clicks += 1;
			},
		});

		visible[0].onClick?.();
		expect(clicks).toBe(1);

		dismissToast(id);
	});
});

describe("updateToast", () => {
	test("replaces the message and can cancel the pending dismissal", () => {
		const id = showToast("Downloading…", { durationMs: 100 });

		updateToast(id, { message: "Downloading… 42%", durationMs: null });
		expect(visible[0].message).toBe("Downloading… 42%");

		runTimers();
		expect(visible).toHaveLength(1);

		dismissToast(id);
	});

	test("can drop the click handler so the action only runs once", () => {
		const id = showToast("Update available", { durationMs: null });

		updateToast(id, { onClick: undefined });
		expect(visible[0].onClick).toBeUndefined();

		dismissToast(id);
	});

	test("ignores unknown ids", () => {
		updateToast(12345, { message: "nope" });
		expect(visible).toEqual([]);
	});
});
