import { Dialog } from "@kobalte/core/dialog";
import { HardDrive, Loader2, Music2, Trash2 } from "@lucide/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import { removeDownloads, useDownloads } from "@/lib/downloads/downloads";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatBytes } from "@/lib/utils/utils";

function DownloadThumb(props: { thumbnail: string | null }) {
	const [failed, setFailed] = createSignal(false);
	return (
		<Show
			fallback={
				<div class="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
					<Music2 class="size-4 text-muted-foreground" />
				</div>
			}
			when={!failed() && props.thumbnail}
		>
			{(thumbnail) => (
				<img
					alt=""
					class="size-9 shrink-0 rounded-md border border-foreground/10 object-cover"
					onError={() => setFailed(true)}
					src={proxiedImageUrl(thumbnail())}
				/>
			)}
		</Show>
	);
}

/**
 * Lists the songs saved for offline playback and lets the user delete them
 * (individually or all at once). Opened from Settings → Storage.
 */
export function StorageManagerDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const downloads = useDownloads();
	const [busy, setBusy] = createSignal(false);
	const list = createMemo(() =>
		[...downloads.entries.values()].sort(
			(a, b) => b.downloadedAt - a.downloadedAt,
		),
	);

	const removeAll = async () => {
		if (busy() || list().length === 0) return;
		setBusy(true);
		try {
			await removeDownloads(list().map((entry) => entry.id));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog onOpenChange={props.onOpenChange} open={props.open}>
			<Dialog.Portal>
				<Dialog.Overlay class="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-[closed]:opacity-0" />
				<Dialog.Content class="fixed top-1/2 left-1/2 z-100 flex w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-foreground/10 bg-popover p-5 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-[closed]:scale-95 data-[closed]:opacity-0">
					<Dialog.Title class="text-base font-semibold">
						Download storage
					</Dialog.Title>
					<Dialog.Description class="mt-1.5 text-sm text-muted-foreground">
						Songs saved on this device for offline playback.
					</Dialog.Description>

					<Show
						fallback={
							<div class="grid place-items-center gap-2 py-12 text-center text-muted-foreground">
								<HardDrive class="size-6" />
								<p class="text-sm">
									No downloads yet. Use "Download" on a song or playlist.
								</p>
							</div>
						}
						when={list().length > 0}
					>
						<div class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
							<span>
								{list().length === 1 ? "1 song" : `${list().length} songs`}
							</span>
							<span class="font-mono tabular-nums">
								{formatBytes(downloads.totalBytes)}
							</span>
						</div>
						<div class="mt-2 max-h-[min(22rem,calc(100vh-12rem))] overflow-y-auto">
							<ul class="space-y-1 pr-1">
								<For each={list()} keyed={(entry) => entry.id}>
									{(entry) => (
										<li class="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors duration-150 hover:bg-foreground/5">
											<DownloadThumb thumbnail={entry().thumbnail} />
											<div class="min-w-0 flex-1">
												<p class="truncate text-sm font-medium">
													{entry().title}
												</p>
												<p class="truncate text-xs text-muted-foreground">
													{entry().artist} · {formatBytes(entry().size)}
												</p>
											</div>
											<button
												aria-label={`Remove ${entry().title}`}
												class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
												disabled={busy()}
												onClick={() => void removeDownloads([entry().id])}
												type="button"
											>
												<Trash2 class="size-3.5" />
											</button>
										</li>
									)}
								</For>
							</ul>
						</div>
					</Show>

					<div class="mt-4 flex justify-end gap-2">
						<Show when={list().length > 0}>
							<button
								class="flex items-center gap-2 rounded-lg border border-destructive/30 px-3.5 py-2 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-50"
								disabled={busy()}
								onClick={() => void removeAll()}
								type="button"
							>
								<Show fallback={<Trash2 class="size-3.5" />} when={busy()}>
									<Loader2 class="size-3.5 animate-spin" />
								</Show>
								Remove all
							</button>
						</Show>
						<Dialog.CloseButton class="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
							Close
						</Dialog.CloseButton>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}
