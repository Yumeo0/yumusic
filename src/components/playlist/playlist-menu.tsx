import { ContextMenu } from "@kobalte/core/context-menu";
import {
	Download,
	Loader2,
	Pencil,
	Pin,
	Share2,
	Shuffle,
	Trash2,
} from "@lucide/solid";
import type { JSX } from "@solidjs/web";
import type { Component } from "solid-js";
import { createSignal, Show } from "solid-js";
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

type MenuIcon = Component<{ class?: string }>;

/** Fisher-Yates shuffle into a new array. */
function shuffleSongs(tracks: Song[]): Song[] {
	const queue = [...tracks];
	for (let i = queue.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[queue[i], queue[j]] = [queue[j], queue[i]];
	}
	return queue;
}

function MenuItem(props: {
	icon: MenuIcon;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	iconClass?: string;
}) {
	return (
		<ContextMenu.Item
			class="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-60 data-highlighted:bg-foreground/8"
			disabled={props.disabled}
			onClick={props.onClick}
		>
			<props.icon class={cn("size-4 text-muted-foreground", props.iconClass)} />
			{props.label}
		</ContextMenu.Item>
	);
}

export function PlaylistContextMenu(props: {
	playlist: PlaylistRef;
	isPinned: boolean;
	onTogglePinned: () => void;
	onDeleted?: () => void;
	onEdit?: () => void;
	songs?: Song[];
	highlight?: boolean;
	class?: string;
	children: JSX.Element;
}) {
	const player = usePlayer();
	const downloads = useDownloads();
	const [busy, setBusy] = createSignal(false);
	const [confirmOpen, setConfirmOpen] = createSignal(false);
	const rawId = () =>
		props.playlist.id.startsWith("VL")
			? props.playlist.id.slice(2)
			: props.playlist.id;
	const downloadJob = () => downloads.jobs.get(props.playlist.id);
	const downloaded = usePlaylistDownloaded(() => props.playlist.id);

	const playShuffled = (tracks: Song[]) => {
		const queue = shuffleSongs(tracks);
		void player.play(queue[0], queue.slice(1));
	};

	const shufflePlay = () => {
		if (busy()) return;
		setBusy(true);
		try {
			const songs = props.songs;
			const known =
				songs && songs.length > 0
					? songs
					: readCachedPlaylistSongs(props.playlist.id);
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
			void loadPlaylistSongs(props.playlist.id, (page) => {
				firstPage = page;
				if (page.length > 0) playShuffled(page);
			})
				.then((all) => {
					if (all.length === 0) {
						showToast("Playlist is empty");
						return;
					}
					refreshCachedPlaylistSongs(props.playlist.id, all);
					const rest = all.slice(firstPage?.length ?? 0);
					if (rest.length > 0) player.addToQueue(shuffleSongs(rest));
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
			<ContextMenu>
				<ContextMenu.Trigger
					class={cn(
						props.highlight !== false && "context-menu-highlight",
						props.class ?? "contents",
					)}
				>
					{props.children}
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Content class="z-90 min-w-44 origin-(--kb-menu-content-transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-[closed]:scale-95 data-[closed]:opacity-0">
						<Show when={props.onEdit}>
							{(onEdit) => (
								<MenuItem
									icon={Pencil}
									label="Edit playlist"
									onClick={onEdit()}
								/>
							)}
						</Show>
						<MenuItem
							icon={Shuffle}
							label="Shuffle play"
							onClick={shufflePlay}
						/>
						<Show
							fallback={
								<Show
									fallback={
										<MenuItem
											icon={Download}
											label={
												isAlbumId(props.playlist.id)
													? "Download album"
													: "Download playlist"
											}
											onClick={() =>
												togglePlaylistDownload(
													props.playlist.id,
													props.playlist.title,
													props.songs,
												)
											}
										/>
									}
									when={downloaded()}
								>
									<MenuItem
										icon={PlaylistDownloadOffIcon}
										label={`Stop downloading ${isAlbumId(props.playlist.id) ? "album" : "playlist"}`}
										onClick={() =>
											togglePlaylistDownload(
												props.playlist.id,
												props.playlist.title,
												props.songs,
											)
										}
									/>
								</Show>
							}
							when={downloadJob()}
						>
							{(job) => (
								<MenuItem
									disabled
									icon={Loader2}
									iconClass="animate-spin"
									label={
										job().total > 0
											? `Downloading ${job().done}/${job().total}`
											: "Preparing download…"
									}
									onClick={() => undefined}
								/>
							)}
						</Show>
						<MenuItem
							icon={Pin}
							label={props.isPinned ? "Unpin from sidebar" : "Pin to sidebar"}
							onClick={props.onTogglePinned}
						/>
						<ContextMenu.Separator class="my-1 h-px bg-foreground/8" />
						<MenuItem
							icon={Share2}
							label="Share playlist"
							onClick={() =>
								void shareLink({
									title: props.playlist.title,
									url: `https://music.youtube.com/playlist?list=${rawId()}`,
								})
							}
						/>
						<Show when={!isAlbumId(props.playlist.id)}>
							<ContextMenu.Separator class="my-1 h-px bg-foreground/8" />
							<MenuItem
								icon={Trash2}
								label="Delete playlist"
								onClick={() => setConfirmOpen(true)}
							/>
						</Show>
					</ContextMenu.Content>
				</ContextMenu.Portal>
			</ContextMenu>
			<ConfirmDeletePlaylistDialog
				isPinned={props.isPinned}
				onDeleted={props.onDeleted}
				onOpenChange={setConfirmOpen}
				onTogglePinned={props.onTogglePinned}
				open={confirmOpen()}
				playlistId={props.playlist.id}
				playlistTitle={props.playlist.title}
			/>
		</>
	);
}
