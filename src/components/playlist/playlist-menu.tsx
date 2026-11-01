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
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import {
	togglePlaylistDownload,
	useDownloads,
	usePlaylistDownloaded,
} from "@/lib/downloads/downloads";
import { shareLink } from "@/lib/services/share";
import {
	readCachedPlaylistSongs,
	refreshCachedPlaylistSongs,
} from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { cn } from "@/lib/utils/utils";
import { loadPlaylistSongs } from "@/lib/youtube/playlist-data";
import { isAlbumId } from "@/lib/youtube/youtube.utils";
import { ConfirmDeletePlaylistDialog } from "./confirm-delete-playlist-dialog";

interface PlaylistRef {
	id: string;
	title: string;
	thumbnail?: string | null;
}

/** Fisher-Yates shuffle into a new array. */
function shuffleSongs(tracks: Song[]): Song[] {
	const queue = [...tracks];
	for (let i = queue.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[queue[i], queue[j]] = [queue[j], queue[i]];
	}
	return queue;
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
	onDeleted,
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
	onDeleted?: () => void;
	onEdit?: () => void;
	songs?: Song[];
	highlight?: boolean;
	className?: string;
	children: ReactNode;
	allowDelete?: boolean;
}) {
	const { addToQueue, play } = usePlayer();
	const downloads = useDownloads();
	const [busy, setBusy] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const rawId = playlist.id.startsWith("VL")
		? playlist.id.slice(2)
		: playlist.id;
	const downloadJob = downloads.jobs.get(playlist.id);
	const downloaded = usePlaylistDownloaded(playlist.id);

	const playShuffled = (tracks: Song[]) => {
		const queue = shuffleSongs(tracks);
		play(queue[0], queue.slice(1));
	};

	const shufflePlay = () => {
		if (busy) return;
		setBusy(true);
		try {
			const known =
				songs && songs.length > 0
					? songs
					: readCachedPlaylistSongs(playlist.id);
			if (known) {
				if (known.length === 0) {
					showToast("Playlist is empty");
					return;
				}
				playShuffled(known);
				return;
			}
			// No usable cache: start from the first page, then append the
			// remaining pages to the queue once they finish loading.
			let firstPage: Song[] | null = null;
			void loadPlaylistSongs(playlist.id, (page) => {
				firstPage = page;
				if (page.length > 0) playShuffled(page);
			})
				.then((all) => {
					if (all.length === 0) {
						showToast("Playlist is empty");
						return;
					}
					refreshCachedPlaylistSongs(playlist.id, all);
					const rest = all.slice(firstPage?.length ?? 0);
					if (rest.length > 0) addToQueue(shuffleSongs(rest));
				})
				.catch((error) => {
					console.error("[YuMusic] shuffle playlist failed:", error);
					if (!firstPage) showToast("Could not load playlist");
				});
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger
					className={cn(highlight && "context-menu-highlight", className)}
				>
					{children}
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Positioner className="z-90 outline-none" sideOffset={6}>
						<ContextMenu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
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
				isPinned={isPinned}
				onDeleted={onDeleted}
				onOpenChange={setConfirmOpen}
				onTogglePinned={onTogglePinned}
				open={confirmOpen}
				playlistId={playlist.id}
				playlistTitle={playlist.title}
			/>
		</>
	);
}
