import { Copy, Minus, Square, X } from "@lucide/solid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createSignal, onSettled, Show } from "solid-js";
import { IS_MOBILE } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";

const appWindow = getCurrentWindow();

/**
 * Custom window decorations: drag region + minimize/maximize/close. The
 * maximize button reflects the window state via the resize event.
 */
export function Titlebar() {
	if (IS_MOBILE) return null;

	const [maximized, setMaximized] = createSignal(false);

	onSettled(() => {
		let unlisten: (() => void) | undefined;
		let disposed = false;
		appWindow
			.onResized(async () => {
				setMaximized(await appWindow.isMaximized());
			})
			.then((dispose) => {
				if (disposed) dispose();
				else unlisten = dispose;
			});
		appWindow
			.isMaximized()
			.then(setMaximized)
			.catch(() => undefined);
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	return (
		<div
			class="relative z-[70] flex h-9 shrink-0 items-center justify-between bg-sidebar pl-2 select-none"
			data-tauri-drag-region
		>
			<div class="pointer-events-none flex items-center gap-2 pl-1">
				<img alt="" class="size-5 rounded-md" src="/icon-637.png" />
				<span class="text-sm font-semibold tracking-tight">YuMusic</span>
			</div>
			<div class="flex items-center gap-0.5 pr-1">
				<button
					aria-label="Minimize window"
					class={cn(TitlebarButtonClass)}
					onClick={() => appWindow.minimize()}
					type="button"
				>
					<Minus class="size-4" />
				</button>
				<button
					aria-label={maximized() ? "Restore window" : "Maximize window"}
					class={cn(TitlebarButtonClass)}
					onClick={() => appWindow.toggleMaximize()}
					type="button"
				>
					<Show fallback={<Square class="size-3" />} when={maximized()}>
						<Copy class="size-3.5 -scale-x-100" />
					</Show>
				</button>
				<button
					aria-label="Close window"
					class={cn(
						TitlebarButtonClass,
						"hover:bg-destructive hover:text-white",
					)}
					onClick={() => appWindow.close()}
					type="button"
				>
					<X class="size-4" />
				</button>
			</div>
		</div>
	);
}

const TitlebarButtonClass =
	"grid size-8 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground";
