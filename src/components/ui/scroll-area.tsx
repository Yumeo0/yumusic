import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";

import { cn } from "@/lib/utils/utils";

function ScrollArea({
	className,
	viewportClassName,
	children,
	...props
}: ScrollAreaPrimitive.Root.Props & { viewportClassName?: string }) {
	return (
		<ScrollAreaPrimitive.Root
			className={cn("relative", className)}
			data-slot="scroll-area"
			{...props}
		>
			<ScrollAreaPrimitive.Viewport
				className={cn(
					"focus-visible:ring-ring/50 size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1",
					viewportClassName,
				)}
				data-slot="scroll-area-viewport"
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			<ScrollBar />
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	);
}

function ScrollBar({
	className,
	orientation = "vertical",
	...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
	return (
		<ScrollAreaPrimitive.Scrollbar
			className={cn(
				"flex touch-none p-px transition-colors select-none",
				// Keyed off the prop, not `data-vertical`: Base UI renders
				// `data-orientation`, so attribute variants never matched and
				// the bar collapsed to a zero-width sliver.
				orientation === "horizontal"
					? "h-2.5 flex-col border-t border-t-transparent"
					: "w-2 h-full border-l border-l-transparent",
				className,
			)}
			data-orientation={orientation}
			data-slot="scroll-area-scrollbar"
			orientation={orientation}
			{...props}
		>
			<ScrollAreaPrimitive.Thumb
				className="relative flex-1 rounded-full bg-foreground/10 transition-colors hover:bg-primary/40"
				data-slot="scroll-area-thumb"
			/>
		</ScrollAreaPrimitive.Scrollbar>
	);
}

export { ScrollArea, ScrollBar };
