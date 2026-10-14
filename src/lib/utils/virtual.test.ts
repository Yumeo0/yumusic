import { expect, test } from "bun:test";
import { createRoot } from "solid-js";
import {
	createVirtualizer,
	type VirtualizerController,
} from "@/lib/utils/virtual";

/**
 * Regression guard for the adapter's mount protocol: virtual-core attaches
 * its scroll/rect observers inside `_willUpdate`, which the framework
 * adapter must call (react-virtual does it from a layout effect). Without it
 * `scrollRect` stays null, the visible range stays empty, and a list renders
 * its sized container but no rows.
 */
test("mounts its observers and yields the visible range", async () => {
	// Virtual-core only reads size, document, and listeners from the scroll
	// element, so a plain fake stands in for a real one (no layout in bun).
	const scrollElement = {
		offsetWidth: 800,
		offsetHeight: 500,
		ownerDocument: {
			defaultView: {
				clearTimeout: (id: number) => clearTimeout(id),
				setTimeout: (handler: () => void, timeout?: number) =>
					setTimeout(handler, timeout) as unknown as number,
			},
		},
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
	} as unknown as HTMLElement;

	let controller!: VirtualizerController<HTMLElement>;
	const dispose = createRoot((requestDispose) => {
		controller = createVirtualizer<HTMLElement, HTMLElement>(() => ({
			count: 100,
			estimateSize: () => 50,
			getScrollElement: () => scrollElement,
			initialOffset: () => 100,
			overscan: 0,
			scrollMargin: 0,
		}));
		return requestDispose;
	});

	try {
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(controller.totalSize()).toBe(5000);
		// Viewport 500px tall, scrolled to 100, over 50px rows: 2..11.
		expect(controller.virtualItems().map((item) => item.index)).toEqual([
			2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
		]);
	} finally {
		dispose();
	}
});

test("measureRow stamps the row's index before measuring it", () => {
	const attributes = new Map<string, string>();
	const row = {
		isConnected: true,
		getAttribute: (name: string) => attributes.get(name) ?? null,
		setAttribute: (name: string, value: string) => {
			attributes.set(name, value);
		},
	} as unknown as HTMLElement;

	let controller!: VirtualizerController<HTMLElement>;
	const dispose = createRoot((requestDispose) => {
		controller = createVirtualizer<HTMLElement, HTMLElement>(() => ({
			count: 10,
			estimateSize: () => 50,
			getScrollElement: () => null,
			overscan: 0,
			scrollMargin: 0,
		}));
		return requestDispose;
	});

	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	try {
		controller.measureRow(row, 7);
	} finally {
		console.warn = originalWarn;
		dispose();
	}

	// virtual-core warns (and drops the measurement) when the attribute is
	// missing. The stamp has to happen inside `measureRow` because Solid
	// applies JSX attribute bindings in an effect that runs after refs.
	expect(attributes.get("data-index")).toBe("7");
	expect(warnings).toEqual([]);
});
