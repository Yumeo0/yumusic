import { CheckLine } from "lucide-react";
import type { ComponentPropsWithoutRef } from "react";
import { useDownloads } from "@/lib/downloads/downloads";
import { cn } from "@/lib/utils/utils";

/**
 * Compact "saved offline" marker shown next to a song wherever it is listed.
 * Renders nothing for songs that are not downloaded.
 */
export function DownloadedBadge({
	songId,
	className,
	...props
}: {
	songId: string;
} & Omit<ComponentPropsWithoutRef<"span">, "children">) {
	const downloads = useDownloads();
	if (!downloads.entries.has(songId)) return null;
	return (
		<span
			{...props}
			aria-label="Downloaded"
			className={cn("inline-flex shrink-0 text-muted-foreground", className)}
			role="img"
			title="Downloaded"
		>
			<CheckLine className="size-3.5" />
		</span>
	);
}
