import { For, Show } from "solid-js";
import { toasts } from "@/lib/stores/toast";

/** Bottom-center transient messages (e.g. copy confirmations). */
export function Toaster() {
	return (
		<Show when={toasts().length > 0}>
			<div class="pointer-events-none fixed inset-x-0 bottom-28 z-90 flex flex-col items-center gap-2 px-4">
				<For each={toasts()}>
					{(toast) => (
						<div class="animate-page-in rounded-full border border-foreground/10 bg-popover/95 px-4 py-2 text-sm text-popover-foreground shadow-lg backdrop-blur">
							{toast.message}
						</div>
					)}
				</For>
			</div>
		</Show>
	);
}
