import { ContextMenu } from "@base-ui/react/context-menu";
import { Dialog } from "@base-ui/react/dialog";
import {
	Loader2,
	type LucideIcon,
	Pin,
	Share2,
	Shuffle,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { shareLink } from "@/lib/services/share";
import {
	readCachedPlaylistSongs,
	refreshCachedPlaylistSongs,
	removePlaylistFromCaches,
} from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { cn } from "@/lib/utils/utils";
import { loadPlaylistSongs } from "@/lib/youtube/playlist-data";
import { isAlbumId } from "@/lib/youtube/youtube.utils";
import { deletePlaylist } from "@/lib/youtube/youtube-client";

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
}: {
	icon: LucideIcon;
	label: string;
	onClick: () => void;
}) {
	return (
		<ContextMenu.Item
			className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
			onClick={onClick}
		>
			<Icon className="size-4 text-muted-foreground" />
			{label}
		</ContextMenu.Item>
	);
}

export function PlaylistContextMenu({
	playlist,
	isPinned,
	onTogglePinned,
	onDeleted,
	songs,
	highlight = true,
	className = "contents",
	children,
}: {
	playlist: PlaylistRef;
	isPinned: boolean;
	onTogglePinned: () => void;
	onDeleted?: () => void;
	songs?: Song[];
	highlight?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const { addToQueue, play } = usePlayer();
	const [busy, setBusy] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const rawId = playlist.id.startsWith("VL")
		? playlist.id.slice(2)
		: playlist.id;

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

	const confirmDelete = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await deletePlaylist(playlist.id);
			removePlaylistFromCaches(playlist.id);
			if (isPinned) onTogglePinned();
			setConfirmOpen(false);
			showToast("Playlist deleted");
			onDeleted?.();
		} catch (error) {
			console.error("[YuMusic] delete playlist failed:", error);
			showToast("Could not delete playlist");
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
							<MenuItem
								icon={Shuffle}
								label="Shuffle play"
								onClick={shufflePlay}
							/>
							<MenuItem
								icon={Pin}
								label={isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
								onClick={onTogglePinned}
							/>
							<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
							<MenuItem
								icon={Share2}
								label="Share playlist"
								onClick={() =>
									void shareLink({
										title: playlist.title,
										url: `https://music.youtube.com/playlist?list=${rawId}`,
									})
								}
							/>
							{!isAlbumId(playlist.id) && (
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
			<Dialog.Root onOpenChange={setConfirmOpen} open={confirmOpen}>
				<Dialog.Portal>
					<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
					<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-foreground/10 bg-popover p-5 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
						<Dialog.Title className="text-base font-semibold">
							Delete playlist?
						</Dialog.Title>
						<Dialog.Description className="mt-1.5 text-sm text-muted-foreground">
							"{playlist.title}" will be permanently deleted from your YouTube
							Music library.
						</Dialog.Description>
						<div className="mt-5 flex justify-end gap-2">
							<Dialog.Close className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
								Cancel
							</Dialog.Close>
							<button
								className="flex items-center gap-2 rounded-lg bg-destructive px-3.5 py-2 text-sm font-semibold text-destructive-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
								disabled={busy}
								onClick={() => void confirmDelete()}
								type="button"
							>
								{busy && <Loader2 className="size-3.5 animate-spin" />}
								Delete
							</button>
						</div>
					</Dialog.Popup>
				</Dialog.Portal>
			</Dialog.Root>
		</>
	);
}
