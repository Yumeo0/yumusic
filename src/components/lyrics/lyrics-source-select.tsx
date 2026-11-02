import { Select } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
	LyricsProvider,
	LyricsProviderId,
} from "@/lib/lyrics/lyrics-providers";
import { beginPressDragSelect } from "@/lib/motion/press-drag-select";
import { haptic } from "@/lib/utils/haptics";
import { cn } from "@/lib/utils/utils";

export function LyricsSourceSelect({
	providers,
	value,
	onChange,
}: {
	providers: readonly LyricsProvider[];
	value: LyricsProviderId;
	onChange: (value: LyricsProviderId) => void;
}) {
	const [open, setOpen] = useState(false);
	const [pressing, setPressing] = useState(false);
	const [highlighted, setHighlighted] = useState<LyricsProviderId | null>(null);
	const popup = useRef<HTMLDivElement>(null);
	const stop = useRef<(() => void) | null>(null);
	const suppressClick = useRef(false);
	useEffect(() => () => stop.current?.(), []);
	return (
		<Select.Root
			disabled={providers.length < 2}
			items={providers.map((provider) => ({
				value: provider.id,
				label: provider.label,
			}))}
			onOpenChange={(next) => {
				if (!next) {
					stop.current?.();
					stop.current = null;
					setHighlighted(null);
					setPressing(false);
				}
				setOpen(next);
			}}
			onValueChange={(next) => {
				if (next && providers.some((provider) => provider.id === next))
					onChange(next);
			}}
			open={open}
			value={
				providers.some((provider) => provider.id === value)
					? value
					: providers[0]?.id
			}
		>
			<Select.Trigger
				aria-label="Lyrics source"
				className="flex h-full w-full touch-none select-none items-center justify-between gap-2 rounded-lg border border-foreground/10 bg-foreground/5 px-3 text-xs font-medium text-foreground outline-none transition-colors hover:bg-foreground/8 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 data-popup-open:bg-foreground/8 disabled:cursor-default"
				data-swipe-dismiss-ignore
				onClickCapture={(event) => {
					if (!suppressClick.current) return;
					suppressClick.current = false;
					event.preventDefault();
					event.stopPropagation();
				}}
				onContextMenu={(event) => event.preventDefault()}
				onKeyDownCapture={() => {
					suppressClick.current = false;
				}}
				onPointerDownCapture={(event) => {
					suppressClick.current = false;
					if (
						providers.length < 2 ||
						!event.isPrimary ||
						event.button !== 0 ||
						event.pointerType === "mouse"
					)
						return;
					event.preventDefault();
					event.stopPropagation();
					event.currentTarget.focus({ preventScroll: true });
					stop.current?.();
					setOpen(true);
					setPressing(true);
					stop.current = beginPressDragSelect<LyricsProviderId>({
						events: document,
						pointerId: event.pointerId,
						x: event.clientX,
						y: event.clientY,
						hitTest: (x, y) => {
							const item = document
								.elementFromPoint(x, y)
								?.closest<HTMLElement>("[data-lyrics-provider]");
							if (!item || !popup.current?.contains(item)) return null;
							return (
								providers.find(
									(provider) => provider.id === item.dataset.lyricsProvider,
								)?.id ?? null
							);
						},
						onHighlight: (next) => {
							setHighlighted(next);
							if (next) haptic("tick");
						},
						onSelect: (next) => {
							haptic("confirm");
							onChange(next);
						},
						onEnd: (dragged, cancelled) => {
							stop.current = null;
							setPressing(false);
							suppressClick.current = true;
							setOpen(!dragged && !cancelled);
						},
					});
				}}
			>
				<Select.Value className="truncate" />
				{providers.length >= 2 && (
					<Select.Icon>
						<ChevronDown
							aria-hidden
							className="size-3.5 text-muted-foreground"
						/>
					</Select.Icon>
				)}
			</Select.Trigger>
			<Select.Portal>
				<Select.Positioner
					align="end"
					alignItemWithTrigger={false}
					className="z-90 outline-none"
					sideOffset={6}
				>
					<Select.Popup
						className="min-w-44 max-w-[calc(100vw-2rem)] origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0"
						ref={popup}
					>
						<Select.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain">
							{providers.map((provider) => (
								<Select.Item
									className={cn(
										"relative flex min-h-10 cursor-default items-center rounded-lg py-2 pr-3 pl-9 text-sm outline-none select-none data-drag-highlighted:bg-foreground/8 data-selected:text-primary",
										!pressing && "data-highlighted:bg-foreground/8",
									)}
									data-drag-highlighted={
										highlighted === provider.id ? "" : undefined
									}
									data-lyrics-provider={provider.id}
									key={provider.id}
									value={provider.id}
								>
									<Select.ItemIndicator className="absolute left-3 flex items-center">
										<Check aria-hidden className="size-4" />
									</Select.ItemIndicator>
									<Select.ItemText>{provider.label}</Select.ItemText>
								</Select.Item>
							))}
						</Select.List>
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
	);
}
