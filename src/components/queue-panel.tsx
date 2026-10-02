import { useVirtualizer } from "@tanstack/react-virtual";
import { ListMusic, X } from "lucide-react";
import { useRef } from "react";
import { SongContextMenu } from "@/components/song-menu";
import { SongTitle } from "@/components/song-title";
import {
	usePlayer,
	usePlayerControls,
	useQueueSheetRef,
} from "@/contexts/player-context";
import { setQueueOpen, useNowPlayingOpen, useQueueOpen } from "@/lib/player-ui";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { ArtistLinks } from "./artist-link";
import { EqualizerBars } from "./waveform";

/**
 * Queue drawer. Desktop: slides in from the right. Mobile: a bottom sheet
 * that slides up — matching the swipe-up gesture, whose reveal progress is
 * driven through the shared sheet ref while the finger is down.
 *
 * Reads its open/fullscreen state from the player UI store rather than props
 * so opening the fullscreen player doesn't re-render the app layout.
 */
export function QueuePanel() {
	const { queue, currentIndex, play } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const sheetRef = useQueueSheetRef();
	const open = useQueueOpen();
	const fullscreen = useNowPlayingOpen();
	const onClose = () => setQueueOpen(false);

	// The queue can hold thousands of tracks; only render the visible rows.
	// The panel stays mounted even when closed (for the drag-follow reveal),
	// so this keeps its DOM and re-render cost tiny in every state.
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowVirtualizer = useVirtualizer({
		count: queue.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 58,
		overscan: 8,
	});

	return (
		<aside
			className={cn(
				// Desktop: blurred translucent drawer from the right. Mobile: the
				// sheet follows the finger every frame while dragging, and
				// re-filtering a backdrop blur per frame tanks the framerate —
				// so the blur is desktop-only and the sheet sits opaque.
				"fixed top-9 right-0 z-60 flex w-80 flex-col border-l border-foreground/10 bg-background/85 backdrop-blur-xl transition-transform duration-300 ease-out max-md:inset-x-0 max-md:top-0 max-md:bottom-0 max-md:w-full max-md:border-l-0 max-md:pt-(--safe-area-top) max-md:bg-background max-md:backdrop-blur-none",
				fullscreen ? "bottom-0" : "bottom-22.5",
				open
					? "translate-x-0 max-md:translate-y-0"
					: "pointer-events-none translate-x-full max-md:translate-x-0 max-md:translate-y-full",
			)}
			ref={sheetRef}
		>
			<div className="flex items-center justify-between border-b border-foreground/8 px-4 py-3.5">
				<div className="flex items-center gap-2.5">
					<ListMusic className="size-4 text-muted-foreground" />
					<span className="text-sm font-semibold">Queue</span>
					{queue.length > 0 && (
						<span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
							{queue.length}
						</span>
					)}
				</div>
				<button
					aria-label="Close queue"
					className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<X className="size-4" />
				</button>
			</div>

			<div
				className="min-h-0 flex-1 overflow-y-auto p-2 max-md:pb-[calc(0.5rem+var(--safe-area-bottom))]"
				ref={scrollRef}
			>
				{queue.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground/70">
						Queue is empty — play something to fill it up.
					</p>
				) : (
					<div
						className="relative"
						style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
					>
						{rowVirtualizer.getVirtualItems().map((virtualRow) => {
							const i = virtualRow.index;
							const song = queue[i];
							const isCurrent = i === currentIndex;
							return (
								<SongContextMenu
									key={`queue-${song.id}-${i}`}
									queueIndex={i}
									song={song}
								>
									<button
										className={cn(
											"group absolute inset-x-0 grid grid-cols-[1.5rem_2.5rem_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
											isCurrent ? "bg-primary/9" : "hover:bg-foreground/5",
										)}
										data-index={virtualRow.index}
										onClick={() => play(song)}
										ref={rowVirtualizer.measureElement}
										style={{
											transform: `translateY(${virtualRow.start}px)`,
										}}
										type="button"
									>
										<span className="relative grid place-items-center">
											{isCurrent ? (
												<EqualizerBars
													className="size-3.5 text-primary"
													playing={isPlaying}
												/>
											) : (
												<span className="font-mono text-[10px] text-muted-foreground/50 transition-opacity duration-150 group-hover:opacity-0">
													{i + 1}
												</span>
											)}
										</span>
										{song.thumbnail ? (
											<img
												alt=""
												className="size-10 rounded-md border border-foreground/10 object-cover"
												loading="lazy"
												src={proxiedImageUrl(song.thumbnail)}
											/>
										) : (
											<div className="size-10 rounded-md bg-muted" />
										)}
										<div className="min-w-0">
											<p
												className={cn(
													"truncate text-sm font-medium",
													isCurrent && "text-primary",
												)}
											>
												<SongTitle artist={song.artist} title={song.title} />
											</p>
											<p className="truncate text-xs text-muted-foreground">
												<ArtistLinks song={song} />
											</p>
										</div>
										{song.duration && (
											<span className="pr-1 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
												{song.duration}
											</span>
										)}
									</button>
								</SongContextMenu>
							);
						})}
					</div>
				)}
			</div>
		</aside>
	);
}
