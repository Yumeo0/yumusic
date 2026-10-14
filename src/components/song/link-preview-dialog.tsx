import { Dialog } from "@kobalte/core/dialog";
import {
	CircleX,
	Download,
	ListMusic,
	ListPlus,
	ListStart,
	Loader2,
	type LucideIcon,
	Play,
	Share2,
	Trash2,
	X,
} from "@lucide/solid";
import { createEffect, createSignal, onSettled, Show } from "solid-js";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import {
	cancelDownload,
	type DownloadEntry,
	type DownloadStatus,
	downloadSong,
	removeDownloads,
	useDownloads,
} from "@/lib/downloads/downloads";
import { shareSong } from "@/lib/services/share";
import { showToast } from "@/lib/stores/toast";
import { IS_MOBILE, proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";
import { getSongPreview, type SongPreview } from "@/lib/youtube/song-info";
import { findVideoId } from "@/lib/youtube/youtube.utils";
import { AddToPlaylistDialog } from "./add-to-playlist-dialog";
import { ArtistLinks } from "./artist-link";
import { SongTitle } from "./song-title";

/** One button of the preview's action grid; Play gets the primary styling. */
function ActionButton(props: {
	icon: LucideIcon;
	label: string;
	onClick: () => void;
	primary?: boolean;
}) {
	return (
		<button
			class={cn(
				"flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 active:scale-95",
				props.primary
					? "bg-primary font-semibold text-primary-foreground hover:brightness-110"
					: "border border-foreground/10 bg-foreground/4 text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
			)}
			onClick={props.onClick}
			type="button"
		>
			<props.icon class="size-4 shrink-0" />
			<span class="truncate">{props.label}</span>
		</button>
	);
}

/** Download button state: icon and label for the song's queue state. */
function downloadAction(
	entry: DownloadEntry | undefined,
	status: DownloadStatus | undefined,
): { icon: LucideIcon; label: string } {
	if (entry) return { icon: Trash2, label: "Remove download" };
	if (status?.phase === "downloading" || status?.phase === "queued") {
		const percent =
			status.phase === "downloading" && status.progress !== null
				? ` (${Math.round(status.progress * 100)}%)`
				: "";
		return { icon: CircleX, label: `Cancel download${percent}` };
	}
	if (status?.phase === "error") {
		return { icon: Download, label: "Retry download" };
	}
	return { icon: Download, label: "Download" };
}

/**
 * Paste-to-preview: pasting a YouTube link anywhere in the desktop app opens
 * a modal with the resolved song and its usual actions (play, play next, add
 * to queue/playlist, download, share). The uploader description is applied up
 * front, so the preview shows the same parsed title and credits playback
 * will use. Mobile has no paste flow — its share sheet handles links instead.
 */
export function LinkPreviewDialog() {
	const player = usePlayer();
	const downloads = useDownloads();
	const [videoId, setVideoId] = createSignal<string | null>(null);
	const [preview, setPreview] = createSignal<SongPreview | null>(null);
	const [failed, setFailed] = createSignal(false);
	const [playlistSong, setPlaylistSong] = createSignal<Song | null>(null);

	// Global paste listener: clipboard text containing a YouTube link opens
	// the preview, replacing whatever the modal showed before.
	onSettled(() => {
		if (IS_MOBILE) return;
		const onPaste = (event: ClipboardEvent) => {
			const id = findVideoId(event.clipboardData?.getData("text") ?? "");
			if (!id) return;
			event.preventDefault();
			setVideoId(id);
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	});

	// Resolve the pasted id while the modal shows its loading state.
	createEffect(
		() => videoId(),
		(id) => {
			if (!id) return;
			let cancelled = false;
			setPreview(null);
			setFailed(false);
			getSongPreview(id).then(
				(result) => {
					if (cancelled) return;
					if (result) setPreview(result);
					else setFailed(true);
				},
				() => {
					if (!cancelled) setFailed(true);
				},
			);
			return () => {
				cancelled = true;
			};
		},
	);

	const song = () => preview()?.song ?? null;
	const download = () => {
		const selected = song();
		return downloadAction(
			selected ? downloads.entries.get(selected.id) : undefined,
			selected ? downloads.statuses.get(selected.id) : undefined,
		);
	};
	const details = () =>
		[song()?.duration, preview()?.album?.name]
			.filter((detail): detail is string => !!detail)
			.join(" · ");

	const close = () => setVideoId(null);

	const playNow = (selected: Song) => {
		void player.play(selected);
		close();
	};

	const playNextTo = (selected: Song) => {
		player.playNext(selected);
		showToast("Playing next");
		close();
	};

	const queueSong = (selected: Song) => {
		// Nothing playing and nothing queued: there is no queue to add behind,
		// so start the song instead (same as the row menu).
		if (!player.currentSong() && player.queue().length === 0) {
			void player.play(selected);
		} else {
			player.addToQueue([selected]);
			showToast("Added to queue");
		}
		close();
	};

	const toggleDownload = (selected: Song) => {
		if (downloads.entries.has(selected.id)) {
			void removeDownloads([selected.id]);
			return;
		}
		const status = downloads.statuses.get(selected.id);
		if (status?.phase === "downloading" || status?.phase === "queued") {
			cancelDownload(selected.id);
			return;
		}
		downloadSong(selected);
	};

	return (
		<>
			<Dialog
				onOpenChange={(open) => {
					if (!open) close();
				}}
				open={videoId() !== null}
			>
				<Dialog.Portal>
					<Dialog.Overlay class="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-[closed]:opacity-0" />
					<Dialog.Content class="fixed top-1/2 left-1/2 z-100 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-[closed]:scale-95 data-[closed]:opacity-0">
						<Dialog.CloseButton
							aria-label="Close"
							class="absolute top-3 right-3 grid size-7 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						>
							<X class="size-4" />
						</Dialog.CloseButton>

						<Show
							fallback={
								<>
									<Dialog.Title class="pr-7 text-sm font-semibold">
										Song preview
									</Dialog.Title>
									<Show
										fallback={
											<p class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
												<Loader2 class="size-3.5 animate-spin" />
												Loading song…
											</p>
										}
										when={failed()}
									>
										<p class="mt-2 text-xs break-all text-muted-foreground">
											Couldn't load{" "}
											<span class="text-foreground/80">
												https://music.youtube.com/watch?v={videoId()}
											</span>
											. Check the link and your connection.
										</p>
									</Show>
								</>
							}
							when={song()}
						>
							{(current) => (
								<>
									<div class="flex items-center gap-3.5 pr-7">
										<img
											alt=""
											class="size-20 shrink-0 rounded-lg border border-foreground/8 object-cover"
											src={proxiedImageUrl(current().thumbnail)}
										/>
										<div class="min-w-0 flex-1">
											<Dialog.Title class="text-sm leading-snug font-semibold">
												<SongTitle
													artist={current().artist}
													keepTitle={current().upload}
													title={current().title}
												/>
											</Dialog.Title>
											<p class="mt-0.5 truncate text-sm text-muted-foreground">
												<ArtistLinks song={current()} />
											</p>
											<Show when={details()}>
												{(info) => (
													<p class="mt-1 truncate text-xs text-muted-foreground/80">
														{info()}
													</p>
												)}
											</Show>
										</div>
									</div>
									<div class="mt-4 grid grid-cols-2 gap-2">
										<ActionButton
											icon={Play}
											label="Play"
											onClick={() => playNow(current())}
											primary
										/>
										<ActionButton
											icon={ListStart}
											label="Play next"
											onClick={() => playNextTo(current())}
										/>
										<ActionButton
											icon={ListPlus}
											label="Add to queue"
											onClick={() => queueSong(current())}
										/>
										<ActionButton
											icon={ListMusic}
											label="Add to playlist"
											onClick={() => setPlaylistSong(current())}
										/>
										<ActionButton
											icon={download().icon}
											label={download().label}
											onClick={() => toggleDownload(current())}
										/>
										<ActionButton
											icon={Share2}
											label="Share"
											onClick={() => void shareSong(current())}
										/>
									</div>
								</>
							)}
						</Show>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog>
			<AddToPlaylistDialog
				onOpenChange={(open) => {
					if (!open) setPlaylistSong(null);
				}}
				open={playlistSong() !== null}
				song={playlistSong()}
			/>
		</>
	);
}
