import { Dialog } from "@base-ui/react/dialog";
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
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { IS_MOBILE, proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";
import { getSongPreview, type SongPreview } from "@/lib/youtube/song-info";
import { findVideoId } from "@/lib/youtube/youtube.utils";
import { AddToPlaylistDialog } from "./add-to-playlist-dialog";
import { ArtistLinks } from "./artist-link";
import { SongTitle } from "./song-title";

/** One button of the preview's action grid; Play gets the primary styling. */
function ActionButton({
	icon: Icon,
	label,
	onClick,
	primary = false,
}: {
	icon: LucideIcon;
	label: string;
	onClick: () => void;
	primary?: boolean;
}) {
	return (
		<button
			className={cn(
				"flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 active:scale-95",
				primary
					? "bg-primary font-semibold text-primary-foreground hover:brightness-110"
					: "border border-foreground/10 bg-foreground/4 text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			<Icon className="size-4 shrink-0" />
			<span className="truncate">{label}</span>
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
	const { addToQueue, play, playNext } = usePlayer();
	const downloads = useDownloads();
	const [videoId, setVideoId] = useState<string | null>(null);
	const [preview, setPreview] = useState<SongPreview | null>(null);
	const [failed, setFailed] = useState(false);
	const [playlistSong, setPlaylistSong] = useState<Song | null>(null);

	// Global paste listener: clipboard text containing a YouTube link opens
	// the preview, replacing whatever the modal showed before.
	useEffect(() => {
		if (IS_MOBILE) return;
		const onPaste = (event: ClipboardEvent) => {
			const id = findVideoId(event.clipboardData?.getData("text") ?? "");
			if (!id) return;
			event.preventDefault();
			setVideoId(id);
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, []);

	// Resolve the pasted id while the modal shows its loading state.
	useEffect(() => {
		if (!videoId) return;
		let cancelled = false;
		setPreview(null);
		setFailed(false);
		getSongPreview(videoId).then(
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
	}, [videoId]);

	const song = preview?.song ?? null;
	const download = downloadAction(
		song ? downloads.entries.get(song.id) : undefined,
		song ? downloads.statuses.get(song.id) : undefined,
	);
	const details = [song?.duration, preview?.album?.name]
		.filter((detail): detail is string => !!detail)
		.join(" · ");

	const close = () => setVideoId(null);

	const playNow = (selected: Song) => {
		play(selected);
		close();
	};

	const playNextTo = (selected: Song) => {
		playNext(selected);
		close();
	};

	const queueSong = (selected: Song) => {
		addToQueue([selected]);
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
			<Dialog.Root
				onOpenChange={(open) => {
					if (!open) close();
				}}
				open={videoId !== null}
			>
				<Dialog.Portal>
					<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
					<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-foreground/10 bg-popover p-4 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
						<Dialog.Close
							aria-label="Close"
							className="absolute top-3 right-3 grid size-7 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						>
							<X className="size-4" />
						</Dialog.Close>

						{song ? (
							<>
								<div className="flex items-center gap-3.5 pr-7">
									<img
										alt=""
										className="size-20 shrink-0 rounded-lg border border-foreground/8 object-cover"
										src={proxiedImageUrl(song.thumbnail)}
									/>
									<div className="min-w-0 flex-1">
										<Dialog.Title className="text-sm leading-snug font-semibold">
											<SongTitle
												artist={song.artist}
												keepTitle={song.upload}
												title={song.title}
											/>
										</Dialog.Title>
										<p className="mt-0.5 truncate text-sm text-muted-foreground">
											<ArtistLinks song={song} />
										</p>
										{details && (
											<p className="mt-1 truncate text-xs text-muted-foreground/80">
												{details}
											</p>
										)}
									</div>
								</div>
								<div className="mt-4 grid grid-cols-2 gap-2">
									<ActionButton
										icon={Play}
										label="Play"
										onClick={() => playNow(song)}
										primary
									/>
									<ActionButton
										icon={ListStart}
										label="Play next"
										onClick={() => playNextTo(song)}
									/>
									<ActionButton
										icon={ListPlus}
										label="Add to queue"
										onClick={() => queueSong(song)}
									/>
									<ActionButton
										icon={ListMusic}
										label="Add to playlist"
										onClick={() => setPlaylistSong(song)}
									/>
									<ActionButton
										icon={download.icon}
										label={download.label}
										onClick={() => toggleDownload(song)}
									/>
									<ActionButton
										icon={Share2}
										label="Share"
										onClick={() => void shareSong(song)}
									/>
								</div>
							</>
						) : (
							<>
								<Dialog.Title className="pr-7 text-sm font-semibold">
									Song preview
								</Dialog.Title>
								{failed ? (
									<p className="mt-2 text-xs break-all text-muted-foreground">
										Couldn't load{" "}
										<span className="text-foreground/80">
											https://music.youtube.com/watch?v={videoId}
										</span>
										. Check the link and your connection.
									</p>
								) : (
									<p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
										<Loader2 className="size-3.5 animate-spin" />
										Loading song…
									</p>
								)}
							</>
						)}
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
			<AddToPlaylistDialog
				onOpenChange={(open) => {
					if (!open) setPlaylistSong(null);
				}}
				open={playlistSong !== null}
				song={playlistSong}
			/>
		</>
	);
}
