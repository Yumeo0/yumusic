import { Dialog } from "@base-ui/react/dialog";
import { HardDrive, Loader2, Music2, Trash2 } from "lucide-react";
import { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { removeDownloads, useDownloads } from "@/lib/downloads/downloads";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatBytes } from "@/lib/utils/utils";

function DownloadThumb({ thumbnail }: { thumbnail: string | null }) {
	const [failed, setFailed] = useState(false);
	if (!thumbnail || failed) {
		return (
			<div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
				<Music2 className="size-4 text-muted-foreground" />
			</div>
		);
	}
	return (
		<img
			alt=""
			className="size-9 shrink-0 rounded-md border border-foreground/10 object-cover"
			onError={() => setFailed(true)}
			src={proxiedImageUrl(thumbnail)}
		/>
	);
}

/**
 * Lists the songs saved for offline playback and lets the user delete them
 * (individually or all at once). Opened from Settings → Storage.
 */
export function StorageManagerDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const downloads = useDownloads();
	const [busy, setBusy] = useState(false);
	const list = [...downloads.entries.values()].sort(
		(a, b) => b.downloadedAt - a.downloadedAt,
	);

	const removeAll = async () => {
		if (busy || list.length === 0) return;
		setBusy(true);
		try {
			await removeDownloads(list.map((entry) => entry.id));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root onOpenChange={onOpenChange} open={open}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 flex w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-foreground/10 bg-popover p-5 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
					<Dialog.Title className="text-base font-semibold">
						Download storage
					</Dialog.Title>
					<Dialog.Description className="mt-1.5 text-sm text-muted-foreground">
						Songs saved on this device for offline playback.
					</Dialog.Description>

					{list.length === 0 ? (
						<div className="grid place-items-center gap-2 py-12 text-center text-muted-foreground">
							<HardDrive className="size-6" />
							<p className="text-sm">
								No downloads yet. Use "Download" on a song or playlist.
							</p>
						</div>
					) : (
						<>
							<div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
								<span>
									{list.length === 1 ? "1 song" : `${list.length} songs`}
								</span>
								<span className="font-mono tabular-nums">
									{formatBytes(downloads.totalBytes)}
								</span>
							</div>
							<ScrollArea
								className="mt-2"
								viewportClassName="max-h-[min(22rem,calc(100vh-12rem))]"
							>
								<ul className="space-y-1 pr-1">
									{list.map((entry) => (
										<li
											className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-foreground/5"
											key={entry.id}
										>
											<DownloadThumb thumbnail={entry.thumbnail} />
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{entry.title}
												</p>
												<p className="truncate text-xs text-muted-foreground">
													{entry.artist} · {formatBytes(entry.size)}
												</p>
											</div>
											<button
												aria-label={`Remove ${entry.title}`}
												className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
												disabled={busy}
												onClick={() => void removeDownloads([entry.id])}
												type="button"
											>
												<Trash2 className="size-3.5" />
											</button>
										</li>
									))}
								</ul>
							</ScrollArea>
						</>
					)}

					<div className="mt-4 flex justify-end gap-2">
						{list.length > 0 && (
							<button
								className="flex items-center gap-2 rounded-lg border border-destructive/30 px-3.5 py-2 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
								disabled={busy}
								onClick={() => void removeAll()}
								type="button"
							>
								{busy ? (
									<Loader2 className="size-3.5 animate-spin" />
								) : (
									<Trash2 className="size-3.5" />
								)}
								Remove all
							</button>
						)}
						<Dialog.Close className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
							Close
						</Dialog.Close>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
