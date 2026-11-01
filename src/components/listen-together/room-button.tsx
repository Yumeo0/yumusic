import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Headphones } from "lucide-react";
import { useListenRoom } from "@/lib/listen-together/room";
import { useMediaQuery } from "@/lib/utils/hooks";
import { cn } from "@/lib/utils/utils";

export const ROOM_DESKTOP_QUERY = "(min-width: 768px)";
/** Player triggers share the responsive app-wide room surface. */
export const roomDialogHandle = Dialog.createHandle();
export const roomPopoverHandle = Popover.createHandle();

export function RoomButton() {
	const desktop = useMediaQuery(ROOM_DESKTOP_QUERY);
	const room = useListenRoom();
	const requests = room.pending.length + room.requests.length;
	const trigger = (
		<button
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
			onClick={(event) => event.stopPropagation()}
			title="Listen together"
			type="button"
		/>
	);
	const content = (
		<>
			<Headphones aria-hidden className="size-5" />
			{requests > 0 && (
				<span
					aria-hidden
					className="absolute -top-0.5 -right-1 min-w-4 rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground"
				>
					{requests > 99 ? "99+" : requests}
				</span>
			)}
		</>
	);
	return desktop ? (
		<Popover.Trigger
			closeDelay={300}
			delay={200}
			handle={roomPopoverHandle}
			openOnHover
			render={trigger}
		>
			{content}
		</Popover.Trigger>
	) : (
		<Dialog.Trigger handle={roomDialogHandle} render={trigger}>
			{content}
		</Dialog.Trigger>
	);
}
