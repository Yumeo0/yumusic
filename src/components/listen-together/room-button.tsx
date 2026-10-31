import { Dialog } from "@base-ui/react/dialog";
import { Headphones } from "lucide-react";
import { useListenRoom } from "@/lib/listen-together/room";
import { cn } from "@/lib/utils/utils";

/** Connects the pill and player buttons to the single app-wide room dialog. */
export const roomDialogHandle = Dialog.createHandle();

export function RoomButton() {
	const room = useListenRoom();
	const requests = room.pending.length + room.requests.length;
	return (
		<Dialog.Trigger
			aria-label={
				requests
					? `Listen together, ${requests} pending requests`
					: "Listen together"
			}
			className={cn(
				"relative grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground",
				room.role ? "text-primary" : "text-muted-foreground",
			)}
			data-swipe-dismiss-ignore
			handle={roomDialogHandle}
			title="Listen together"
			type="button"
		>
			<Headphones aria-hidden className="size-5" />
			{requests > 0 && (
				<span
					aria-hidden
					className="absolute -top-0.5 -right-1 min-w-4 rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground"
				>
					{requests > 99 ? "99+" : requests}
				</span>
			)}
		</Dialog.Trigger>
	);
}
