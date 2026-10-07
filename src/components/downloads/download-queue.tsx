import { Popover } from "@base-ui/react/popover";
import { Download, HardDrive, Loader2, RotateCw, X } from "lucide-react";
import { useState } from "react";
import { StorageManagerDialog } from "@/components/settings/storage-manager-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	cancelDownload,
	dismissDownloadError,
	downloadSong,
	useDownloads,
} from "@/lib/downloads/downloads";
import { cn } from "@/lib/utils/utils";

function percent(progress: number | null): string | null {
	return progress === null ? null : `${Math.round(progress * 100)}%`;
}

/**
 * Download queue: a trigger that opens a popover with the running track, the
 * waiting ones and any failures (with retry/dismiss). Progress lives here
 * instead of in per-track toasts; finished songs leave the queue and a button
 * opens the storage manager right on the current page.
 *
 * Two shapes: the sidebar row (`compact` false) and the floating mobile pill
 * (`compact`), which hides itself while the queue is empty.
 */
export function DownloadQueueButton({
	align = "start",
	className,
	compact = false,
	side = "top",
}: {
	align?: "start" | "center" | "end";
	className?: string;
	compact?: boolean;
	side?: "top" | "bottom";
}) {
	const downloads = useDownloads();
	const [storageOpen, setStorageOpen] = useState(false);
	const { tasks, failed } = downloads;
	const running = tasks.find((task) => task.phase === "downloading");
	const busy = tasks.length + failed.length;
	if (compact && busy === 0) return null;

	const progress = percent(running?.progress ?? null);

	return (
		<Popover.Root>
			<Popover.Trigger
				className={cn(
					compact
						? "flex items-center gap-1.5 rounded-full border border-foreground/10 bg-background/90 px-3 py-2 text-xs font-semibold shadow-lg backdrop-blur-md transition-colors duration-200 hover:bg-background"
						: "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-foreground/5 hover:text-foreground",
					className,
				)}
			>
				{tasks.length > 0 ? (
					<Loader2
						className={cn(
							"shrink-0 animate-spin text-primary",
							compact ? "size-4" : "size-4.5",
						)}
					/>
				) : (
					<Download
						className={cn("shrink-0", compact ? "size-4" : "size-4.5")}
					/>
				)}
				{compact ? (
					<span className="tabular-nums">{progress ?? busy}</span>
				) : (
					<>
						<span className="flex-1 text-left">Download queue</span>
						{busy > 0 && (
							<span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary tabular-nums">
								{progress ?? busy}
							</span>
						)}
					</>
				)}
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Positioner
					align={align}
					className="z-90 outline-none"
					collisionPadding={8}
					side={side}
					sideOffset={8}
				>
					<Popover.Popup className="w-80 max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-3 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
						<p className="px-1.5 pb-1 font-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase">
							Downloads
						</p>
						{busy === 0 ? (
							<p className="px-1.5 py-3 text-sm text-muted-foreground">
								No active downloads.
							</p>
						) : (
							<ScrollArea viewportClassName="max-h-80">
								<div className="space-y-0.5 pr-1">
									{tasks.map((task) => {
										const value = percent(task.progress);
										return (
											<div
												className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-foreground/5"
												key={task.song.id}
											>
												<div className="min-w-0 flex-1">
													<p className="truncate text-xs font-medium">
														{task.song.title}
													</p>
													{task.phase === "downloading" ? (
														<div className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
															{value === null ? (
																// Until the total size is known, a full bar
																// reads as "finished"; sweep a segment instead.
																<div className="h-full w-2/5 animate-download-slide rounded-full bg-primary" />
															) : (
																<div
																	className="h-full rounded-full bg-primary transition-[width] duration-300"
																	style={{ width: value }}
																/>
															)}
														</div>
													) : (
														<p className="truncate text-[11px] text-muted-foreground">
															Queued · {task.song.artist}
														</p>
													)}
												</div>
												{task.phase === "downloading" && (
													<span className="w-9 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
														{value ?? "…"}
													</span>
												)}
												<button
													aria-label={`Cancel download of ${task.song.title}`}
													className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground"
													onClick={() => cancelDownload(task.song.id)}
													title="Cancel download"
													type="button"
												>
													<X className="size-3.5" />
												</button>
											</div>
										);
									})}
									{failed.map((song) => (
										<div
											className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-foreground/5"
											key={song.id}
										>
											<div className="min-w-0 flex-1">
												<p className="truncate text-xs font-medium">
													{song.title}
												</p>
												<p className="truncate text-[11px] text-destructive">
													Download failed
												</p>
											</div>
											<button
												aria-label={`Retry downloading ${song.title}`}
												className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground"
												onClick={() => downloadSong(song)}
												title="Retry download"
												type="button"
											>
												<RotateCw className="size-3.5" />
											</button>
											<button
												aria-label={`Dismiss failed download of ${song.title}`}
												className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground"
												onClick={() => dismissDownloadError(song.id)}
												title="Dismiss"
												type="button"
											>
												<X className="size-3.5" />
											</button>
										</div>
									))}
								</div>
							</ScrollArea>
						)}
						<Popover.Close
							className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-foreground/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground"
							onClick={() => setStorageOpen(true)}
						>
							<HardDrive className="size-3.5" />
							Manage downloads
						</Popover.Close>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
			{/* Finished downloads live in the storage manager, opened in place
			    so managing them never leaves the current page. */}
			<StorageManagerDialog onOpenChange={setStorageOpen} open={storageOpen} />
		</Popover.Root>
	);
}
