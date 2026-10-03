import { ContextMenu } from "@base-ui/react/context-menu";
import {
	Braces,
	FileText,
	Fingerprint,
	Image as ImageIcon,
	Languages,
	ListMusic,
	ListPlus,
	ListStart,
	type LucideIcon,
	MicVocal,
	Share2,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { useSettings } from "@/lib/settings";
import { shareLink } from "@/lib/share";
import { displayTitle } from "@/lib/title";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AddToPlaylistDialog } from "./add-to-playlist-dialog";

/** Copy the song's YouTube Music link, or open the native share sheet. */
function shareSong(song: Song) {
	void shareLink({
		title: song.title,
		text: `${song.artist} — ${song.title}`,
		url: `https://music.youtube.com/watch?v=${song.id}`,
	});
}

/** Copies text to the clipboard and reports the result as a toast. */
async function copyText(text: string, label: string) {
	try {
		await navigator.clipboard.writeText(text);
		showToast(`${label} copied`);
	} catch {
		showToast(`Could not copy ${label.toLowerCase()}`);
	}
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

/**
 * Right-click (desktop) / long-press (touch) menu for a song row or card.
 * The trigger defaults to `display: contents` so wrapping rows and cards
 * doesn't disturb their layout.
 */
export function SongContextMenu({
	song,
	queueIndex,
	onRemove,
	removeLabel = "Remove from playlist",
	children,
	className = "contents",
}: {
	/** The song to act on; when absent the children render untouched. */
	song?: Song;
	/** Queue position, when the wrapped element is a queue row. */
	queueIndex?: number;
	/** Called by the "Remove" item, e.g. to delete the row from a playlist. */
	onRemove?: () => void;
	/** Label of the "Remove" item; defaults to the playlist wording. */
	removeLabel?: string;
	children: ReactNode;
	className?: string;
}) {
	const { addToQueue, play, playNext, removeFromQueueAt, queue, currentSong } =
		usePlayer();
	const [settings] = useSettings();
	const [playlistSong, setPlaylistSong] = useState<Song | null>(null);
	const navigate = useNavigate();

	if (!song) return <>{children}</>;

	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger className={cn("song-menu", className)}>
					{children}
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Positioner className="z-90 outline-none" sideOffset={6}>
						<ContextMenu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
							<MenuItem
								icon={ListStart}
								label="Play next"
								onClick={() => {
									playNext(song);
									showToast("Playing next");
								}}
							/>
							<MenuItem
								icon={ListPlus}
								label="Add to queue"
								onClick={() => {
									// Nothing playing and nothing queued: there is no
									// queue to add behind, so start the song instead.
									if (!currentSong && queue.length === 0) {
										play(song);
										return;
									}
									addToQueue([song]);
									showToast("Added to queue");
								}}
							/>
							<MenuItem
								icon={ListMusic}
								label="Add to playlist"
								onClick={() => setPlaylistSong(song)}
							/>
							<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
							{song.artistId && (
								<MenuItem
									icon={MicVocal}
									label="Go to artist"
									onClick={() => navigate(`/artist/${song.artistId}`)}
								/>
							)}
							<MenuItem
								icon={Share2}
								label="Share song"
								onClick={() => void shareSong(song)}
							/>
							{(onRemove || queueIndex !== undefined) && (
								<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
							)}
							{onRemove && (
								<MenuItem
									icon={Trash2}
									label={removeLabel}
									onClick={onRemove}
								/>
							)}
							{queueIndex !== undefined && (
								<MenuItem
									icon={Trash2}
									label="Remove from queue"
									onClick={() => removeFromQueueAt(queueIndex)}
								/>
							)}
							{settings.developerMode && (
								<>
									<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
									<ContextMenu.Group>
										<ContextMenu.GroupLabel className="px-2.5 pt-1.5 pb-0.5 font-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase select-none">
											Developer
										</ContextMenu.GroupLabel>
										<MenuItem
											icon={Languages}
											label="Copy original title"
											onClick={() =>
												void copyText(
													displayTitle(
														song.title,
														"original",
														settings.cleanTitles,
														song.artist,
													),
													"Original title",
												)
											}
										/>
										<MenuItem
											icon={FileText}
											label="Copy raw title"
											onClick={() => void copyText(song.title, "Raw title")}
										/>
										<MenuItem
											icon={Fingerprint}
											label="Copy video ID"
											onClick={() => void copyText(song.id, "Video ID")}
										/>
										<MenuItem
											icon={ImageIcon}
											label="Copy thumbnail URL"
											onClick={() =>
												void copyText(song.thumbnail, "Thumbnail URL")
											}
										/>
										<MenuItem
											icon={Braces}
											label="Copy song data"
											onClick={() =>
												void copyText(
													JSON.stringify(song, null, 2),
													"Song data",
												)
											}
										/>
									</ContextMenu.Group>
								</>
							)}
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</ContextMenu.Portal>
			</ContextMenu.Root>
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
