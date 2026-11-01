import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Headphones, X } from "lucide-react";
import { useMediaQuery } from "@/lib/utils/hooks";
import {
	ROOM_DESKTOP_QUERY,
	roomDialogHandle,
	roomPopoverHandle,
} from "./room-button";
import { RoomPanel } from "./room-panel";

/** An anchored desktop panel and a fullscreen mobile room dialog. */
export function RoomActivity() {
	const desktop = useMediaQuery(ROOM_DESKTOP_QUERY);
	if (desktop)
		return (
			<Popover.Root handle={roomPopoverHandle}>
				<Popover.Portal className="relative z-100">
					<Popover.Positioner
						align="center"
						className="outline-none"
						collisionPadding={12}
						side="top"
						sideOffset={10}
					>
						<Popover.Popup className="flex max-h-[min(36rem,var(--available-height))] w-[44rem] max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
							<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
								<Popover.Title className="flex items-center gap-2 text-base font-semibold">
									<Headphones aria-hidden className="size-5 text-primary" />
									Listen together
								</Popover.Title>
								<Popover.Close
									aria-label="Close listen together"
									className="rounded-full p-2 text-muted-foreground hover:bg-muted"
								>
									<X aria-hidden className="size-4" />
								</Popover.Close>
							</div>
							<div className="min-h-0 overflow-y-auto overscroll-contain">
								<RoomPanel embedded />
							</div>
						</Popover.Popup>
					</Popover.Positioner>
				</Popover.Portal>
			</Popover.Root>
		);
	return (
		<Dialog.Root handle={roomDialogHandle}>
			<Dialog.Portal>
				<Dialog.Popup className="fixed inset-0 z-100 flex h-dvh w-full flex-col overflow-hidden bg-background pt-(--safe-area-top) pb-(--safe-area-bottom)">
					<div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3">
						<Dialog.Title className="flex items-center gap-2 text-lg font-semibold tracking-tight">
							<Headphones aria-hidden className="size-5 text-primary" />
							Listen together
						</Dialog.Title>
						<Dialog.Close
							aria-label="Close listen together"
							className="rounded-full p-2 text-muted-foreground hover:bg-muted"
						>
							<X aria-hidden className="size-4" />
						</Dialog.Close>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
						<RoomPanel embedded />
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
