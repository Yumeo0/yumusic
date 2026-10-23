import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/** Long playlists keep their data, but mount only the rows near the viewport. */
export function VirtualTrackList({
	count,
	getKey,
	children,
}: {
	count: number;
	getKey: (index: number) => string;
	children: (index: number) => ReactNode;
}) {
	const container = useRef<HTMLUListElement>(null);
	const [margin, setMargin] = useState(0);
	const [focused, setFocused] = useState<number | null>(null);
	const scrollElement = useCallback(
		() =>
			container.current?.closest<HTMLElement>(
				"[data-slot=scroll-area-viewport]",
			) ?? null,
		[],
	);
	const virtualizer = useVirtualizer({
		count,
		getScrollElement: scrollElement,
		estimateSize: () => 58,
		getItemKey: getKey,
		scrollMargin: margin,
		overscan: 6,
		rangeExtractor: (range) => {
			const visible = defaultRangeExtractor(range);
			return focused !== null && focused < count && !visible.includes(focused)
				? [...visible, focused].sort((a, b) => a - b)
				: visible;
		},
	});
	useLayoutEffect(() => {
		const list = container.current;
		const scroller = scrollElement();
		if (!list || !scroller) return;
		const measure = () =>
			setMargin(
				list.getBoundingClientRect().top -
					scroller.getBoundingClientRect().top +
					scroller.scrollTop,
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		if (list.parentElement) observer.observe(list.parentElement);
		if (list.parentElement?.parentElement)
			observer.observe(list.parentElement.parentElement);
		return () => observer.disconnect();
	}, [scrollElement]);
	return (
		<ul
			className="m-0 list-none p-0"
			onBlurCapture={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget))
					setFocused(null);
			}}
			onFocusCapture={(event) => {
				const row = (event.target as HTMLElement).closest<HTMLElement>(
					"[data-index]",
				);
				if (row) setFocused(Number(row.dataset.index));
			}}
			ref={container}
			style={{ height: virtualizer.getTotalSize(), position: "relative" }}
		>
			{virtualizer.getVirtualItems().map((row) => (
				<li
					aria-posinset={row.index + 1}
					aria-setsize={count}
					data-index={row.index}
					key={row.key}
					ref={virtualizer.measureElement}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: "100%",
						paddingBottom: 2,
						transform: `translateY(${row.start - margin}px)`,
					}}
				>
					{children(row.index)}
				</li>
			))}
		</ul>
	);
}
