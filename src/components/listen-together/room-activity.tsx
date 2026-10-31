import { Dialog } from "@base-ui/react/dialog";
import { Headphones, X } from "lucide-react";
import { useListenRoom } from "@/lib/listen-together/room";
import { useNowPlayingOpen } from "@/lib/player/player-ui";
import { roomDialogHandle } from "./room-button";
import { RoomPanel } from "./room-panel";

/** Manage the live room without leaving the music being browsed. */
export function RoomActivity({ playing }: { playing: boolean }) {
	const room = useListenRoom();
	const fullscreen = useNowPlayingOpen();
	const requests = room.pending.length + room.requests.length;
	return (
		<Dialog.Root handle={roomDialogHandle}>
			{(!fullscreen || !playing) && (
				<Dialog.Trigger
					aria-label="Open listen together room"
					className={`fixed right-4 ${fullscreen ? "z-[65]" : "z-45"} flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border border-primary/20 bg-popover px-4 py-2.5 text-xs font-medium shadow-lg transition-colors hover:bg-primary/10 ${playing ? "bottom-[calc(10rem+var(--safe-area-bottom))] md:bottom-28" : "bottom-[calc(4.5rem+var(--safe-area-bottom))] md:bottom-5"}`}
					handle={roomDialogHandle}
					type="button"
				>
					<Headphones className="size-4 text-primary" />
					<span>
						{room.error
							? "Room disconnected"
							: requests
								? `${requests} room ${requests === 1 ? "request" : "requests"}`
								: room.status === "reconnecting"
									? "Room reconnecting…"
									: room.role
										? `Listen together · ${room.members.length}`
										: "Listen together"}
					</span>
				</Dialog.Trigger>
			)}
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 hidden bg-black/60 backdrop-blur-sm md:block" />
				<Dialog.Popup className="fixed inset-0 z-100 flex h-dvh w-full flex-col overflow-hidden bg-background pt-(--safe-area-top) pb-(--safe-area-bottom) md:inset-auto md:top-1/2 md:left-1/2 md:h-auto md:max-h-[calc(100dvh-3rem)] md:w-[min(48rem,calc(100vw-3rem))] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl md:border md:border-foreground/10 md:bg-popover md:py-0 md:shadow-2xl">
					<div className="mx-auto flex w-full max-w-3xl shrink-0 items-center justify-between gap-4 border-b border-foreground/10 px-4 py-3 sm:px-6">
						<div>
							<Dialog.Title className="flex items-center gap-2 text-lg font-semibold tracking-tight">
								<Headphones aria-hidden className="size-5 text-primary" />
								Listen together
							</Dialog.Title>
						</div>
						<Dialog.Close
							aria-label="Close listen together"
							className="rounded-full p-2 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
						>
							<X aria-hidden className="size-4" />
						</Dialog.Close>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
						<div className="mx-auto max-w-3xl">
							<RoomPanel embedded />
						</div>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
