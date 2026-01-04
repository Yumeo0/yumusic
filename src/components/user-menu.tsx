import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
				className="flex items-center gap-3 px-4 py-3 w-full rounded-lg hover:bg-muted transition-colors text-left"
				onClick={() => setIsOpen(!isOpen)}
				type="button"
			>
				{user.photo ? (
					<img
						alt={user.name}
						className="w-8 h-8 rounded-full object-cover"
						src={user.photo}
					/>
				) : (
					<div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold">
						{user.name?.[0]?.toUpperCase() || "U"}
					</div>
				)}
				<div className="flex-1 min-w-0">
					<p className="text-sm font-medium truncate">{user.name || "User"}</p>
				</div>
			</button>

			{isOpen && (
				<div className="absolute bottom-full left-0 w-full mb-2 bg-popover border rounded-lg shadow-lg overflow-hidden z-50">
					<div className="p-1">
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-destructive/10 rounded-md transition-colors"
							onClick={() => {
								setIsOpen(false);
								onLogout();
							}}
							type="button"
						>
							<LogOut className="w-4 h-4" />
							<span>Log Out</span>
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
