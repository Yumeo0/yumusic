import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface UserMenuProps {
	user: {
		name?: string;
		photo?: string;
	};
	onLogout: () => void;
}

export function UserMenu({ user, onLogout }: UserMenuProps) {
	const [isOpen, setIsOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
				setIsOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, []);

	return (
		<div className="relative" ref={menuRef}>
			<button
				className={cn(
					"flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-200",
					isOpen ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.05]",
				)}
				onClick={() => setIsOpen(!isOpen)}
				type="button"
			>
				{user.photo ? (
					<img
						alt={user.name}
						className="size-9 rounded-full object-cover"
						src={proxiedImageUrl(user.photo)}
					/>
				) : (
					<div className="grid size-9 place-items-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
						{user.name?.[0]?.toUpperCase() || "U"}
					</div>
				)}
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">{user.name || "User"}</p>
				</div>
			</button>

			{isOpen && (
				<div className="animate-pop-in absolute bottom-full left-0 z-50 mb-2 w-full origin-bottom-left overflow-hidden rounded-xl border border-foreground/10 bg-popover/95 shadow-[0_20px_50px_-12px_oklch(0_0_0/0.6)] backdrop-blur-xl">
					<div className="p-1.5">
						<button
							className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm text-destructive transition-colors duration-150 hover:bg-destructive/10"
							onClick={() => {
								setIsOpen(false);
								onLogout();
							}}
							type="button"
						>
							<LogOut className="size-4" />
							<span>Log Out</span>
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
