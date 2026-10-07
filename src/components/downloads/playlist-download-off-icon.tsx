import { Download, X } from "lucide-react";
import { cn } from "@/lib/utils/utils";

/**
 * Download arrow with a small X at the bottom right — the "kept downloaded"
 * state of the playlist download toggle: pressing it stops keeping the
 * playlist saved. Sized by the caller's `className` (e.g. `size-4`).
 */
export function PlaylistDownloadOffIcon({ className }: { className?: string }) {
	return (
		<span className={cn("relative inline-flex shrink-0", className)}>
			<Download className="size-full" />
			<X
				className="absolute -right-1 -bottom-1 size-2.5 rounded-full bg-background"
				strokeWidth={3}
			/>
		</span>
	);
}
