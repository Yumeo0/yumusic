/**
 * Bridge between TanStack's framework-agnostic virtualizer and Solid signals.
 * `@tanstack/solid-virtual` is built for Solid 1.x (uses removed APIs), so
 * the app drives `@tanstack/virtual-core` through this small adapter.
 */
import {
	elementScroll,
	observeElementOffset,
	observeElementRect,
	type VirtualItem,
	Virtualizer,
	type VirtualizerOptions,
} from "@tanstack/virtual-core";
import {
	type Accessor,
	createEffect,
	createSignal,
	onSettled,
	untrack,
} from "solid-js";

export type VirtualAlign = "start" | "center" | "end" | "auto";

/**
 * The nearest vertically scrollable ancestor of `element`. Used by lists that
 * scroll with the page (the app shell's `<main>` scroller owns scrolling for
 * route content) rather than owning a scroll container themselves.
 */
export function findScrollParent(element: Element | null): HTMLElement | null {
	let node = element?.parentElement ?? null;
	while (node) {
		const { overflowY } = getComputedStyle(node);
		if (overflowY === "auto" || overflowY === "scroll") return node;
		node = node.parentElement;
	}
	return null;
}

/**
 * Caller-facing options: the observation/scroll plumbing is supplied by the
 * adapter, so it may be omitted.
 */
export type VirtualizerConfig<
	TScroll extends Element,
	TItem extends Element,
> = Omit<
	VirtualizerOptions<TScroll, TItem>,
	"observeElementOffset" | "observeElementRect" | "scrollToFn" | "onChange"
>;

export interface VirtualizerController<TItem extends Element> {
	/** Currently visible rows; read where they render. */
	virtualItems: Accessor<VirtualItem[]>;
	/** Total height of all rows; read where it renders. */
	totalSize: Accessor<number>;
	/**
	 * Ref callback for a measured row: stamps the row's virtual index onto
	 * the element — virtual-core resolves it from `data-index` — and hands it
	 * to the virtualizer. The stamp happens here rather than as a JSX
	 * `data-index={index}` binding: Solid applies attribute bindings in an
	 * effect that runs after refs, so the measurement would be dropped.
	 */
	measureRow: (element: TItem | null, index: number) => void;
	scrollToIndex: (
		index: number,
		options?: { align?: VirtualAlign; behavior?: ScrollBehavior },
	) => void;
	getOffsetForIndex: (
		index: number,
		align?: VirtualAlign,
	) => readonly [number, VirtualAlign] | undefined;
}

export function createVirtualizer<
	TScroll extends Element,
	TItem extends Element,
>(
	options: () => VirtualizerConfig<TScroll, TItem>,
): VirtualizerController<TItem> {
	const [virtualItems, setVirtualItems] = createSignal<VirtualItem[]>([]);
	const [totalSize, setTotalSize] = createSignal(0);

	const sync = () => {
		setVirtualItems(instance.getVirtualItems().slice());
		setTotalSize(instance.getTotalSize());
	};

	const instance = new Virtualizer<TScroll, TItem>({
		...untrack(options),
		observeElementOffset,
		observeElementRect,
		onChange: sync,
		scrollToFn: elementScroll,
	});

	// Mount the observers once the scroll element ref has been assigned.
	// `_willUpdate` is what attaches the scroll/rect observers in
	// virtual-core; the framework adapter is responsible for calling it (see
	// react-virtual's layout effects) — `_didMount` only hands back the
	// unmount cleanup.
	onSettled(() => {
		instance._willUpdate();
		sync();
		return instance._didMount();
	});

	createEffect(
		() => options(),
		(next) => {
			instance.setOptions({
				...next,
				observeElementOffset,
				observeElementRect,
				onChange: sync,
				scrollToFn: elementScroll,
			});
			// `getScrollElement()` starts returning an element only after the
			// owning ref is assigned; re-running `_willUpdate` is what mounts
			// the observers at that point.
			instance._willUpdate();
			sync();
		},
	);

	return {
		getOffsetForIndex: (index, align = "auto") =>
			instance.getOffsetForIndex(index, align),
		measureRow: (element, index) => {
			if (element) element.setAttribute("data-index", `${index}`);
			instance.measureElement(element);
		},
		scrollToIndex: (index, opts) =>
			instance.scrollToIndex(index, opts ? { align: opts.align } : undefined),
		totalSize,
		virtualItems,
	};
}
