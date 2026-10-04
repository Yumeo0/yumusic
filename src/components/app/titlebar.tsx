import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { IS_MOBILE } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";

const appWindow = getCurrentWindow();

/**
 * Custom window decorations: drag region + minimize/maximize/close. The
 * maximize button reflects the window state via the resize event.
 */
export function Titlebar() {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		appWindow
			.onResized(async () => {
				setMaximized(await appWindow.isMaximized());
			})
			.then((dispose) => {
				unlisten = dispose;
			});
		appWindow
			.isMaximized()
			.then(setMaximized)
			.catch(() => undefined);
		return () => {
			unlisten?.();
		};
	}, []);

	// Mobile platforms keep their system window chrome.
	if (IS_MOBILE) return null;

	return (
		<div
			className="relative z-[70] flex h-9 shrink-0 items-center justify-between bg-sidebar pl-2 select-none"
			data-tauri-drag-region
		>
			<div className="pointer-events-none flex items-center gap-2 pl-1">
				<img alt="" className="size-5 rounded-md" src="/icon-637.png" />
				<span className="text-sm font-semibold tracking-tight">YuMusic</span>
			</div>
			<div className="flex items-center gap-0.5 pr-1">
				<button
					aria-label="Minimize window"
					className={cn(TitlebarButtonClass)}
					onClick={() => appWindow.minimize()}
					type="button"
				>
					<Minus className="size-4" />
				</button>
				<button
					aria-label={maximized ? "Restore window" : "Maximize window"}
					className={cn(TitlebarButtonClass)}
					onClick={() => appWindow.toggleMaximize()}
					type="button"
				>
					{maximized ? (
						<Copy className="size-3.5 -scale-x-100" />
					) : (
						<Square className="size-3" />
					)}
				</button>
				<button
					aria-label="Close window"
					className={cn(
						TitlebarButtonClass,
						"hover:bg-destructive hover:text-white",
					)}
					onClick={() => appWindow.close()}
					type="button"
				>
					<X className="size-4" />
				</button>
			</div>
		</div>
	);
}

const TitlebarButtonClass =
	"grid size-8 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground";
