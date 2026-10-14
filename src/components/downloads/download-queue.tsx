import { Popover } from "@kobalte/core/popover";
import { Download, HardDrive, Loader2, RotateCw, X } from "@lucide/solid";
import { createSignal, For, Show } from "solid-js";
import { StorageManagerDialog } from "@/components/settings/storage-manager-dialog";
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
export function DownloadQueueButton(props: {
	align?: "start" | "center" | "end";
	class?: string;
	compact?: boolean;
	side?: "top" | "bottom";
}) {
	const downloads = useDownloads();
	const [storageOpen, setStorageOpen] = createSignal(false);
	const tasks = () => downloads.tasks;
	const failed = () => downloads.failed;
	const busy = () => tasks().length + failed().length;
	const running = () => tasks().find((task) => task.phase === "downloading");
	const progress = () => percent(running()?.progress ?? null);

	return (
		<Show when={!props.compact || busy() > 0}>
			<Popover>
				<Popover.Trigger
					class={cn(
						props.compact
							? "flex items-center gap-1.5 rounded-full border border-foreground/10 bg-background/90 px-3 py-2 text-xs font-semibold shadow-lg backdrop-blur-md transition-colors duration-200 hover:bg-background"
							: "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-foreground/5 hover:text-foreground",
						props.class,
					)}
				>
					<Show
						fallback={
							<Download
								class={cn("shrink-0", props.compact ? "size-4" : "size-4.5")}
							/>
						}
						when={tasks().length > 0}
					>
						<Loader2
							class={cn(
								"shrink-0 animate-spin text-primary",
								props.compact ? "size-4" : "size-4.5",
							)}
						/>
					</Show>
					<Show
						fallback={
							<>
								<span class="flex-1 text-left">Download queue</span>
								<Show when={busy() > 0}>
									<span class="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[10px] text-primary tabular-nums">
										{progress() ?? busy()}
									</span>
								</Show>
							</>
						}
						when={props.compact}
					>
						<span class="tabular-nums">{progress() ?? busy()}</span>
					</Show>
				</Popover.Trigger>
				<Popover.Portal>
					<Popover.Content class="z-90 w-80 max-w-[calc(100vw-1.5rem)] origin-(--kb-popover-content-transform-origin) rounded-xl border border-foreground/10 bg-popover p-3 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-[closed]:scale-95 data-[closed]:opacity-0">
						<p class="px-1.5 pb-1 font-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase">
							Downloads
						</p>
						<Show
							fallback={
								<p class="px-1.5 py-3 text-sm text-muted-foreground">
									No active downloads.
								</p>
							}
							when={busy() > 0}
						>
							<div class="max-h-80 overflow-y-auto">
								<div class="space-y-0.5 pr-1">
									<For each={tasks()} keyed={(task) => task.song.id}>
										{(task) => {
											const value = () => percent(task().progress);
											return (
												<div class="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-foreground/5">
													<div class="min-w-0 flex-1">
														<p class="truncate text-xs font-medium">
															{task().song.title}
														</p>
														<Show
															fallback={
																<p class="truncate text-[11px] text-muted-foreground">
																	Queued · {task().song.artist}
																</p>
															}
															when={task().phase === "downloading"}
														>
															<div class="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
																<Show
																	fallback={
																		// Until the total size is known, a full bar
																		// reads as "finished"; sweep a segment instead.
																		<div class="h-full w-2/5 animate-download-slide rounded-full bg-primary" />
																	}
																	when={value()}
																>
																	{(width) => (
																		<div
																			class="h-full rounded-full bg-primary transition-[width] duration-300"
																			style={{ width: width() }}
																		/>
																	)}
																</Show>
															</div>
														</Show>
													</div>
													<Show when={task().phase === "downloading"}>
														<span class="w-9 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
															{value() ?? "…"}
														</span>
													</Show>
													<button
														aria-label={`Cancel download of ${task().song.title}`}
														class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground"
														onClick={() => cancelDownload(task().song.id)}
														title="Cancel download"
														type="button"
													>
														<X class="size-3.5" />
													</button>
												</div>
											);
										}}
									</For>
									<For each={failed()}>
										{(song) => (
											<div class="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 hover:bg-foreground/5">
												<div class="min-w-0 flex-1">
													<p class="truncate text-xs font-medium">
														{song.title}
													</p>
													<p class="truncate text-[11px] text-destructive">
														Download failed
													</p>
												</div>
												<button
													aria-label={`Retry downloading ${song.title}`}
													class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground"
													onClick={() => downloadSong(song)}
													title="Retry download"
													type="button"
												>
													<RotateCw class="size-3.5" />
												</button>
												<button
													aria-label={`Dismiss failed download of ${song.title}`}
													class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground"
													onClick={() => dismissDownloadError(song.id)}
													title="Dismiss"
													type="button"
												>
													<X class="size-3.5" />
												</button>
											</div>
										)}
									</For>
								</div>
							</div>
						</Show>
						<Popover.CloseButton
							class="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-foreground/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground"
							onClick={() => setStorageOpen(true)}
						>
							<HardDrive class="size-3.5" />
							Manage downloads
						</Popover.CloseButton>
					</Popover.Content>
				</Popover.Portal>
				{/* Finished downloads live in the storage manager, opened in place
				    so managing them never leaves the current page. */}
				<StorageManagerDialog
					onOpenChange={setStorageOpen}
					open={storageOpen()}
				/>
			</Popover>
		</Show>
	);
}
