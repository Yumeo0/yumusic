import { ContextMenu } from "@base-ui/react/context-menu";
import {
	ListPlus,
	ListStart,
	type LucideIcon,
	MicVocal,
	Share2,
	Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { showToast } from "@/lib/toast";

/** Copy the song's YouTube Music link, or open the native share sheet. */
async function shareSong(song: Song) {
	const url = `https://music.youtube.com/watch?v=${song.id}`;
	if (typeof navigator.share === "function") {
		try {
			await navigator.share({
				title: song.title,
				text: `${song.artist} — ${song.title}`,
				url,
			});
			return;
		} catch (error) {
			// User dismissed the sheet; don't silently copy instead.
			if ((error as Error).name === "AbortError") return;
		}
	}
	try {
		await navigator.clipboard.writeText(url);
		showToast("Link copied to clipboard");
	} catch {
		showToast("Could not copy link");
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
	children,
	className = "contents",
}: {
	/** The song to act on; when absent the children render untouched. */
	song?: Song;
	/** Queue position, when the wrapped element is a queue row. */
	queueIndex?: number;
	children: ReactNode;
	className?: string;
}) {
	const { addToQueue, play, playNext, removeFromQueueAt, queue, currentSong } =
		usePlayer();
	const navigate = useNavigate();

	if (!song) return <>{children}</>;

	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger className={className}>
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
						{song.artistId && (
							<MenuItem
								icon={MicVocal}
								label="Go to artist"
								onClick={() => navigate(`/artist/${song.artistId}`)}
							/>
						)}
						{queueIndex !== undefined && (
							<MenuItem
								icon={Trash2}
								label="Remove from queue"
								onClick={() => removeFromQueueAt(queueIndex)}
							/>
						)}
						<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
						<MenuItem
							icon={Share2}
							label="Share song"
							onClick={() => void shareSong(song)}
						/>
					</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
