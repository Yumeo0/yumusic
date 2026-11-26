import { ContextMenu } from "@base-ui/react/context-menu";
import {
	Download,
	Loader2,
	Pencil,
	Pin,
	Share2,
	Shuffle,
	Trash2,
} from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";
import { PlaylistDownloadOffIcon } from "@/components/downloads/playlist-download-off-icon";
import { usePlayer } from "@/contexts/player-context";
import {
	togglePlaylistDownload,
	usePlaylistDownloaded,
	usePlaylistDownloadJob,
} from "@/lib/downloads/downloads";
import { preventSwipeContextMenu } from "@/lib/motion/swipe-context-menu";
import type { Song } from "@/lib/music/song";
import { shuffleFrom } from "@/lib/player/shuffle";
import { shareLink } from "@/lib/services/share";
import {
	playlistRevision,
	readFreshPlaylistView,
	writePlaylistView,
} from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { cn } from "@/lib/utils/utils";
import { loadPlaylistView } from "@/lib/youtube/playlist-data";
import { canonicalPlaylistId } from "@/lib/youtube/playlist-id";
import { isAlbumId } from "@/lib/youtube/youtube.utils";
import { ConfirmDeletePlaylistDialog } from "./confirm-delete-playlist-dialog";

interface PlaylistRef {
	id: string;
	title: string;
	thumbnail?: string | null;
}

function MenuItem({
	icon: Icon,
	label,
	onClick,
	disabled = false,
	iconClassName,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	iconClassName?: string;
}) {
	return (
		<ContextMenu.Item
			className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-60 data-highlighted:bg-foreground/8"
			disabled={disabled}
			onClick={onClick}
		>
			<Icon className={cn("size-4 text-muted-foreground", iconClassName)} />
			{label}
		</ContextMenu.Item>
	);
}

export function PlaylistContextMenu({
	playlist,
	isPinned,
	onTogglePinned,
	onEdit,
	songs,
	highlight = true,
	className = "contents",
	allowDelete = true,
	children,
}: {
	playlist: PlaylistRef;
	isPinned: boolean;
	onTogglePinned: () => void;
	onEdit?: () => void;
	songs?: Song[];
	highlight?: boolean;
	className?: string;
	children: ReactNode;
	allowDelete?: boolean;
}) {
	const { addToQueue, play } = usePlayer();
	const [busy, setBusy] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const rawId = canonicalPlaylistId(playlist.id);
	const downloadJob = usePlaylistDownloadJob(playlist.id);
	const downloaded = usePlaylistDownloaded(playlist.id);

	const playShuffled = (tracks: Song[]) => {
		const queue = shuffleFrom(tracks, 0);
		play(queue[0], queue.slice(1));
	};

	const shufflePlay = async () => {
		if (busy) return;
		setBusy(true);
		let started = false;
		try {
			const known = songs?.length
				? songs
				: readFreshPlaylistView(playlist.id)?.songs;
			if (known) {
				if (known.length) playShuffled(known);
				else showToast("Playlist is empty");
				return;
			}
			const revision = playlistRevision(playlist.id);
			let firstCount = 0;
			const view = await loadPlaylistView(playlist.id, {
				onFirstPage: (first) => {
					firstCount = first.songs.length;
					if (!firstCount) return;
					playShuffled(first.songs);
					started = true;
				},
			});
			if (!view) throw new Error("Could not load playlist");
			if (view.songs.length === 0) {
				showToast("Playlist is empty");
				return;
			}
			if (playlistRevision(playlist.id) === revision)
				writePlaylistView(playlist.id, view, { keepComplete: true });
			const rest = shuffleFrom(view.songs.slice(firstCount), 0);
			if (!started) playShuffled(view.songs);
			else if (rest.length) addToQueue(rest);
		} catch (error) {
			console.error("[YuMusic] shuffle playlist failed:", error);
			if (!started) showToast("Could not load playlist");
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<ContextMenu.Root onOpenChange={preventSwipeContextMenu}>
				<ContextMenu.Trigger
					className={cn(highlight && "context-menu-highlight", className)}
				>
					{children}
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Positioner className="z-90 outline-none" sideOffset={6}>
						<ContextMenu.Popup className="ui-popup min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none">
							{onEdit && (
								<MenuItem
									icon={Pencil}
									label="Edit playlist"
									onClick={onEdit}
								/>
							)}
							<MenuItem
								icon={Shuffle}
								label="Shuffle play"
								onClick={shufflePlay}
							/>
							{downloadJob ? (
								<MenuItem
									disabled
									icon={Loader2}
									iconClassName="animate-spin"
									label={
										downloadJob.total > 0
											? `Downloading ${downloadJob.done}/${downloadJob.total}`
											: "Preparing download…"
									}
									onClick={() => undefined}
								/>
							) : downloaded ? (
								<MenuItem
									icon={PlaylistDownloadOffIcon}
									label={`Stop downloading ${isAlbumId(playlist.id) ? "album" : "playlist"}`}
									onClick={() =>
										togglePlaylistDownload(playlist.id, playlist.title, songs)
									}
								/>
							) : (
								<MenuItem
									icon={Download}
									label={
										isAlbumId(playlist.id)
											? "Download album"
											: "Download playlist"
									}
									onClick={() =>
										togglePlaylistDownload(playlist.id, playlist.title, songs)
									}
								/>
							)}
							<MenuItem
								icon={Pin}
								label={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
								onClick={onTogglePinned}
							/>
							<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
							<MenuItem
								icon={Share2}
								label={
									isAlbumId(playlist.id) ? "Share album" : "Share playlist"
								}
								onClick={() =>
									void shareLink({
										title: playlist.title,
										url: isAlbumId(playlist.id)
											? `https://music.youtube.com/browse/${playlist.id}`
											: `https://music.youtube.com/playlist?list=${rawId}`,
									})
								}
							/>
							{allowDelete && !isAlbumId(playlist.id) && (
								<>
									<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
									<MenuItem
										icon={Trash2}
										label="Delete playlist"
										onClick={() => setConfirmOpen(true)}
									/>
								</>
							)}
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</ContextMenu.Portal>
			</ContextMenu.Root>
			<ConfirmDeletePlaylistDialog
				onOpenChange={setConfirmOpen}
				open={confirmOpen}
				playlistId={playlist.id}
				playlistTitle={playlist.title}
			/>
		</>
	);
}
