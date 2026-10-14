import { CheckLine } from "@lucide/solid";
import { Show } from "solid-js";
import { useDownloads } from "@/lib/downloads/downloads";
import { cn } from "@/lib/utils/utils";

/**
 * Compact "saved offline" marker shown next to a song wherever it is listed.
 * Renders nothing for songs that are not downloaded.
 */
export function DownloadedBadge(props: { songId: string; class?: string }) {
	const downloads = useDownloads();
	return (
		<Show when={downloads.entries.has(props.songId)}>
			<span
				aria-label="Downloaded"
				class={cn("inline-flex shrink-0 text-muted-foreground", props.class)}
				role="img"
				title="Downloaded"
			>
				<CheckLine class="size-3.5" />
			</span>
		</Show>
	);
}
