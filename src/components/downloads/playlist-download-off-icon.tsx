import { Download, X } from "@lucide/solid";
import { cn } from "@/lib/utils/utils";

/**
 * Download arrow with a small X at the bottom right — the "kept downloaded"
 * state of the playlist download toggle: pressing it stops keeping the
 * playlist saved. Sized by the caller's `class` (e.g. `size-4`).
 */
export function PlaylistDownloadOffIcon(props: { class?: string }) {
	return (
		<span class={cn("relative inline-flex shrink-0", props.class)}>
			<Download class="size-full" />
			<X
				class="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background"
				stroke-width={3}
			/>
		</span>
	);
}
