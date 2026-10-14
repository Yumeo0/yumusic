import { LogOut } from "@lucide/solid";
import { createSignal, onSettled, Show } from "solid-js";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";

interface UserMenuProps {
	user: {
		name?: string;
		photo?: string;
	};
	onLogout: () => void;
}

export function UserMenu(props: UserMenuProps) {
	const [isOpen, setIsOpen] = createSignal(false);
	let menu!: HTMLDivElement;

	onSettled(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (menu && !menu.contains(event.target as Node)) {
				setIsOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	});

	return (
		<div class="relative" ref={menu}>
			<button
				class={cn(
					"flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-200",
					isOpen() ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.05]",
				)}
				onClick={() => setIsOpen(!isOpen())}
				type="button"
			>
				<Show
					fallback={
						<div class="grid size-9 place-items-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
							{props.user.name?.[0]?.toUpperCase() || "U"}
						</div>
					}
					when={props.user.photo}
				>
					{(photo) => (
						<img
							alt={props.user.name}
							class="size-9 rounded-full object-cover"
							src={proxiedImageUrl(photo())}
						/>
					)}
				</Show>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">
						{props.user.name || "User"}
					</p>
				</div>
			</button>

			<Show when={isOpen()}>
				<div class="animate-pop-in absolute top-full left-0 z-50 mt-2 w-full origin-top-left overflow-hidden rounded-xl border border-foreground/10 bg-popover/95 shadow-[0_20px_50px_-12px_oklch(0_0_0/0.6)] backdrop-blur-xl">
					<div class="p-1.5">
						<button
							class="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-destructive transition-colors duration-150 hover:bg-destructive/10"
							onClick={() => {
								setIsOpen(false);
								props.onLogout();
							}}
							type="button"
						>
							<LogOut class="size-4" />
							<span>Log Out</span>
						</button>
					</div>
				</div>
			</Show>
		</div>
	);
}
