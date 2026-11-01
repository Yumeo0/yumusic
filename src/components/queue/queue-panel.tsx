import { useVirtualizer } from "@tanstack/react-virtual";
import { ListMusic, Shuffle, X } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { CoverImage } from "@/components/song/cover-image";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import {
	usePlayer,
	usePlayerControls,
	useQueueSheetRef,
} from "@/contexts/player-context";
import { useQueueSheetGesture } from "@/lib/motion/queue-drag";
import {
	setQueueOpen,
	useNowPlayingOpen,
	useQueueState,
} from "@/lib/player/player-ui";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";
import { EqualizerBars } from "../player/waveform";
import { ArtistLinks } from "../song/artist-link";

/**
 * Queue drawer. Desktop: slides in from the right. Mobile: a bottom sheet
 * that slides up — matching the swipe-up gesture, whose reveal progress is
 * driven through the shared sheet ref while the finger is down.
 *
 * Reads its open/fullscreen state from the player UI store rather than props
 * so opening the fullscreen player doesn't re-render the app layout.
 */
export function QueuePanel() {
	const {
		queue,
		currentIndex,
		autoplayTracks,
		autoplayEnabled,
		play,
		playAutoplayAt,
		shuffleQueue,
	} = usePlayer();
	const { isPlaying } = usePlayerControls();
	// Video entries already resolved to their song version while playing.
	const versions = useSongVersionReplacements();
	const sheetRef = useQueueSheetRef();
	const sheetGesture = useQueueSheetGesture();
	const queueState = useQueueState();
	const open = queueState !== "closed";
	const fullscreen = useNowPlayingOpen();
	const onClose = () => setQueueOpen(false);
	// Shuffling mixes only the upcoming tracks, so it needs at least two.
	const canShuffle = queue.length - currentIndex - 1 > 1;

	// The queue can hold thousands of tracks; only render the visible rows.
	// The panel stays mounted even when closed (for the drag-follow reveal),
	// so this keeps its DOM and re-render cost tiny in every state.
	// The "Autoplay" separator is an extra virtual row between the user queue
	// and the upcoming radio tracks, shown even while those are still loading
	// so the queue visibly continues instead of ending at the last item.
	const separatorIndex = queue.length;
	const showSeparator =
		autoplayEnabled && (queue.length > 0 || autoplayTracks.length > 0);
	const autoplayOffset = showSeparator ? 1 : 0;
	const rowCount = queue.length + autoplayTracks.length + autoplayOffset;
	const scrollRef = useRef<HTMLDivElement>(null);
	const rowVirtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index) =>
			showSeparator && index === separatorIndex ? 34 : 58,
		overscan: 8,
	});

	// Opening the queue eases from wherever the list was left to the current
	// song. Animated by hand rather than with `behavior: "smooth"`, which
	// WebView2 drops when the OS animation setting is off (same workaround as
	// the lyrics panel). Read through a ref so changing tracks while browsing
	// doesn't yank the list.
	const currentIndexRef = useRef(currentIndex);
	currentIndexRef.current = currentIndex;
	const scrollFrameRef = useRef(0);
	const stopScroll = useCallback(() => {
		cancelAnimationFrame(scrollFrameRef.current);
		scrollFrameRef.current = 0;
	}, []);
	useEffect(() => {
		if (!open) return;
		const container = scrollRef.current;
		const index = currentIndexRef.current;
		if (!container || index < 0) return;
		// Re-read the target every frame: scrolling through a long list renders
		// (and measures) rows, which shifts the offsets and would otherwise
		// leave the animation short or past the song.
		const target = () => {
			const offset = rowVirtualizer.getOffsetForIndex(index, "center")?.[0];
			if (offset === undefined) return null;
			const max = container.scrollHeight - container.clientHeight;
			return Math.min(max, Math.max(0, offset));
		};
		const from = container.scrollTop;
		const initial = target();
		if (initial === null) return;
		const distance = initial - from;
		if (Math.abs(distance) < 1) return;
		const duration = Math.min(900, 450 + Math.abs(distance) * 0.25);
		const start = performance.now();
		const tick = (now: number) => {
			const t = Math.min((now - start) / duration, 1);
			// easeOutCubic: quick off the line, settling onto the song
			const eased = 1 - (1 - t) ** 3;
			const live = target() ?? initial;
			container.scrollTop = from + (live - from) * eased;
			if (t < 1) {
				scrollFrameRef.current = requestAnimationFrame(tick);
			} else {
				scrollFrameRef.current = 0;
				rowVirtualizer.scrollToIndex(index, { align: "center" });
			}
		};
		scrollFrameRef.current = requestAnimationFrame(tick);
		return stopScroll;
	}, [open, rowVirtualizer, stopScroll]);

	return (
		<aside
			className={cn(
				// Desktop: blurred translucent drawer from the right. Mobile: the
				// sheet follows the finger every frame while dragging, and
				// re-filtering a backdrop blur per frame tanks the framerate —
				// so the blur is desktop-only and the sheet sits opaque.
				"fixed top-9 right-0 z-60 flex w-80 flex-col border-l border-foreground/10 bg-background/85 backdrop-blur-xl transition-transform duration-300 ease-out max-md:inset-x-0 max-md:top-0 max-md:bottom-0 max-md:w-full max-md:border-l-0 max-md:bg-background max-md:backdrop-blur-none",
				fullscreen ? "bottom-0" : "bottom-22.5",
				open ? "translate-x-0" : "pointer-events-none translate-x-full",
				"max-md:translate-x-0",
				// The top safe-area inset only matters once the sheet reaches
				// the top of the screen; otherwise a hairline of padding keeps
				// the handle off the edge without reading as dead space.
				queueState === "full"
					? "max-md:translate-y-0 max-md:pt-(--safe-area-top)"
					: queueState === "half"
						? "max-md:translate-y-1/2 max-md:pt-4"
						: "max-md:translate-y-full max-md:pt-4",
			)}
			ref={sheetRef}
		>
			<div
				className="relative flex items-center justify-between border-b border-foreground/8 px-4 py-3.5 max-md:pt-2 max-md:pb-3 max-md:touch-none"
				{...sheetGesture}
			>
				<span
					aria-hidden
					className="pointer-events-none absolute top-1 left-1/2 h-1 w-8 -translate-x-1/2 rounded-full bg-foreground/15 md:hidden"
				/>
				<div className="flex items-center gap-2.5">
					<ListMusic className="size-4 text-muted-foreground" />
					<span className="text-sm font-semibold">Queue</span>
					{queue.length > 0 && (
						<span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
							{queue.length}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					<button
						aria-label="Shuffle queue"
						className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
						disabled={!canShuffle}
						onClick={shuffleQueue}
						title="Shuffle queue"
						type="button"
					>
						<Shuffle className="size-4" />
					</button>
					<button
						aria-label="Close queue"
						className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						onClick={onClose}
						type="button"
					>
						<X className="size-4" />
					</button>
				</div>
			</div>

			<div
				className="min-h-0 flex-1 overflow-y-auto p-2 max-md:pb-[calc(0.5rem+var(--safe-area-bottom))]"
				onTouchMove={stopScroll}
				onWheel={stopScroll}
				ref={scrollRef}
			>
				{queue.length === 0 && autoplayTracks.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground/70">
						Queue is empty — play something to fill it up.
					</p>
				) : (
					<div
						className="relative"
						style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
					>
						{rowVirtualizer.getVirtualItems().map((virtualRow) => {
							if (showSeparator && virtualRow.index === separatorIndex) {
								return (
									<div
										className="absolute inset-x-0 flex items-center gap-2 px-2"
										key="autoplay-separator"
										style={{
											height: `${virtualRow.size}px`,
											transform: `translateY(${virtualRow.start}px)`,
										}}
									>
										<span className="text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
											Autoplay
										</span>
										<span className="h-px flex-1 bg-foreground/10" />
									</div>
								);
							}
							const isAutoplayRow =
								virtualRow.index >= separatorIndex + autoplayOffset;
							const i = isAutoplayRow
								? virtualRow.index - separatorIndex - autoplayOffset
								: virtualRow.index;
							const source = isAutoplayRow ? autoplayTracks[i] : queue[i];
							// Show and play the album track when the video was
							// resolved to one while playing.
							const version = versions.get(source.id);
							const song = version
								? { ...version, addedBy: source.addedBy }
								: source;
							const isCurrent = !isAutoplayRow && i === currentIndex;
							return (
								<SongContextMenu
									key={`${isAutoplayRow ? "auto" : "queue"}-${source.id}-${i}`}
									queueIndex={isAutoplayRow ? undefined : i}
									song={song}
								>
									<button
										className={cn(
											"group absolute inset-x-0 grid grid-cols-[1.5rem_2.5rem_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
											isCurrent ? "bg-primary/9" : "hover:bg-foreground/5",
										)}
										data-index={virtualRow.index}
										onClick={() => {
											if (isAutoplayRow) {
												playAutoplayAt(i);
											} else {
												play(song);
											}
										}}
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
													{isAutoplayRow ? queue.length + i + 1 : i + 1}
												</span>
											)}
										</span>
										{song.thumbnail ? (
											<CoverImage
												alt=""
												className="size-10 rounded-md border border-foreground/10 object-cover"
												loading="lazy"
												src={proxiedImageUrl(song.thumbnail, 96)}
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
												<SongTitle
													artist={song.artist}
													keepTitle={song.upload}
													title={song.title}
												/>
											</p>
											<p className="truncate text-xs text-muted-foreground">
												<ArtistLinks song={song} />
											</p>
											{song.addedBy && (
												<p
													className="truncate text-[10px] text-muted-foreground/70"
													title={`Added by ${song.addedBy}`}
												>
													Added by {song.addedBy}
												</p>
											)}
										</div>
										<div className="flex items-center gap-2 pr-1">
											<DownloadedBadge songId={song.id} />
											{song.duration && (
												<span className="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
													{song.duration}
												</span>
											)}
										</div>
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
