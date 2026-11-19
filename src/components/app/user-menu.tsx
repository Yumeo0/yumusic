import { Menu } from "@base-ui/react/menu";
import { LogOut } from "lucide-react";
import { proxiedImageUrl } from "@/lib/utils/tauri";

interface UserMenuProps {
	user: { name?: string; photo?: string };
	onLogout: () => void;
}

export function UserMenu({ user, onLogout }: UserMenuProps) {
	return (
		<Menu.Root>
			<Menu.Trigger className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-200 hover:bg-foreground/5 data-popup-open:bg-foreground/6">
				{user.photo ? (
					<img
						alt=""
						className="size-9 rounded-full object-cover"
						src={proxiedImageUrl(user.photo)}
					/>
				) : (
					<span className="grid size-9 place-items-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
						{user.name?.[0]?.toUpperCase() || "U"}
					</span>
				)}
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{user.name || "User"}
				</span>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner align="start" className="z-100" sideOffset={8}>
					<Menu.Popup className="ui-popup min-w-(--anchor-width) rounded-xl border border-foreground/10 bg-popover/95 p-1.5 text-popover-foreground shadow-xl outline-none backdrop-blur-xl">
						<Menu.Item
							className="flex cursor-default items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-destructive outline-none data-highlighted:bg-destructive/10"
							onClick={onLogout}
						>
							<LogOut aria-hidden className="size-4" />
							Log out
						</Menu.Item>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
