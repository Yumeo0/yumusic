import { ListMusic, X } from "@lucide/solid";
import { createEffect, For, Show, untrack } from "solid-js";
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
	nowPlayingOpen,
	queueState,
	setQueueOpen,
} from "@/lib/player/player-ui";
import { useSettings } from "@/lib/stores/settings";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";
import { createVirtualizer } from "@/lib/utils/virtual";
import { EqualizerBars } from "../player/waveform";
import { ArtistLinks } from "../song/artist-link";

/**
 * Queue drawer. Desktop: slides in from the right. Mobile: a bottom sheet
 * that slides up — matching the swipe-up gesture, whose reveal progress is
 * driven through the shared sheet ref while the finger is down.
 *
 * Reads its open/fullscreen state from the player UI store rather than props
 * so opening the fullscreen player doesn't touch the app layout.
 */
export function QueuePanel() {
	const player = usePlayer();
	const controls = usePlayerControls();
	// Video entries already resolved to their song version while playing.
	const versions = useSongVersionReplacements();
	const [settings] = useSettings();
	const sheetRef = useQueueSheetRef();
	const sheetGesture = useQueueSheetGesture();

	// The queue can hold thousands of tracks; only render the visible rows.
	// The "Autoplay" separator is an extra virtual row between the user queue
	// and the upcoming radio tracks, shown even while those are still loading
	// so the queue visibly continues instead of ending at the last item.
	const separatorIndex = () => player.queue().length;
	const showSeparator = () =>
		settings.autoplay &&
		(player.queue().length > 0 || player.autoplayTracks().length > 0);
	const autoplayOffset = () => (showSeparator() ? 1 : 0);
	const rowCount = () =>
		player.queue().length + player.autoplayTracks().length + autoplayOffset();
	const open = () => queueState() !== "closed";

	let scroll!: HTMLDivElement;
	const rowVirtualizer = createVirtualizer<HTMLDivElement, HTMLButtonElement>(
		() => ({
			count: rowCount(),
			estimateSize: (index) =>
				showSeparator() && index === separatorIndex() ? 34 : 58,
			getScrollElement: () => scroll,
			overscan: 8,
		}),
	);

	// Opening the queue eases from wherever the list was left to the current
	// song. Animated by hand rather than with `behavior: "smooth"`, which
	// WebView2 drops when the OS animation setting is off (same workaround as
	// the lyrics panel). The target index is read once at open time so
	// changing tracks while browsing doesn't yank the list.
	let scrollFrame = 0;
	const stopScroll = () => {
		cancelAnimationFrame(scrollFrame);
		scrollFrame = 0;
	};
	createEffect(
		() => open(),
		(isOpen) => {
			if (!isOpen) return;
			const container = scroll;
			// Read once at open time (deliberately untracked): changing tracks
			// while browsing must not yank the list.
			const index = untrack(player.currentIndex);
			if (!container || index < 0) return;
			// Re-read the target every frame: scrolling through a long list
			// renders (and measures) rows, which shifts the offsets and would
			// otherwise leave the animation short or past the song.
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
					scrollFrame = requestAnimationFrame(tick);
				} else {
					scrollFrame = 0;
					rowVirtualizer.scrollToIndex(index, { align: "center" });
				}
			};
			scrollFrame = requestAnimationFrame(tick);
			return stopScroll;
		},
	);

	return (
		<aside
			class={cn(
				// Desktop: blurred translucent drawer from the right. Mobile: the
				// sheet follows the finger every frame while dragging, and
				// re-filtering a backdrop blur per frame tanks the framerate —
				// so the blur is desktop-only and the sheet sits opaque.
				"fixed top-9 right-0 z-60 flex w-80 flex-col border-l border-foreground/10 bg-background/85 backdrop-blur-xl transition-transform duration-300 ease-out max-md:inset-x-0 max-md:top-0 max-md:bottom-0 max-md:w-full max-md:border-l-0 max-md:bg-background max-md:backdrop-blur-none",
				nowPlayingOpen() ? "bottom-0" : "bottom-22.5",
				open() ? "translate-x-0" : "pointer-events-none translate-x-full",
				"max-md:translate-x-0",
				// The top safe-area inset only matters once the sheet reaches
				// the top of the screen; otherwise a hairline of padding keeps
				// the handle off the edge without reading as dead space.
				queueState() === "full"
					? "max-md:translate-y-0 max-md:pt-(--safe-area-top)"
					: queueState() === "half"
						? "max-md:translate-y-1/2 max-md:pt-4"
						: "max-md:translate-y-full max-md:pt-4",
			)}
			ref={(el) => {
				sheetRef.current = el;
			}}
		>
			<div
				class="relative flex items-center justify-between border-b border-foreground/8 px-4 py-3.5 max-md:pt-2 max-md:pb-3 max-md:touch-none"
				{...sheetGesture}
			>
				<span
					aria-hidden="true"
					class="pointer-events-none absolute top-1 left-1/2 h-1 w-8 -translate-x-1/2 rounded-full bg-foreground/15 md:hidden"
				/>
				<div class="flex items-center gap-2.5">
					<ListMusic class="size-4 text-muted-foreground" />
					<span class="text-sm font-semibold">Queue</span>
					<Show when={player.queue().length > 0}>
						<span class="rounded-full bg-foreground/[0.07] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
							{player.queue().length}
						</span>
					</Show>
				</div>
				<button
					aria-label="Close queue"
					class="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
					onClick={() => setQueueOpen(false)}
					type="button"
				>
					<X class="size-4" />
				</button>
			</div>

			<div
				class="min-h-0 flex-1 overflow-y-auto p-2 max-md:pb-[calc(0.5rem+var(--safe-area-bottom))]"
				onTouchMove={stopScroll}
				onWheel={stopScroll}
				ref={scroll}
			>
				<Show
					fallback={
						<p class="p-4 text-sm text-muted-foreground/70">
							Queue is empty — play something to fill it up.
						</p>
					}
					when={rowCount() > 0}
				>
					<div
						class="relative"
						style={{ height: `${rowVirtualizer.totalSize()}px` }}
					>
						<For each={rowVirtualizer.virtualItems()} keyed={(row) => row.key}>
							{(vrow) => {
								const index = () => vrow().index;
								const isAutoplayRow = () =>
									index() >= separatorIndex() + autoplayOffset();
								const itemIndex = () =>
									isAutoplayRow()
										? index() - separatorIndex() - autoplayOffset()
										: index();
								const source = () =>
									isAutoplayRow()
										? player.autoplayTracks()[itemIndex()]
										: player.queue()[itemIndex()];
								const song = () => {
									const entry = source();
									return entry ? (versions.get(entry.id) ?? entry) : undefined;
								};
								const isCurrent = () =>
									!isAutoplayRow() && itemIndex() === player.currentIndex();
								return (
									<Show
										fallback={
											<Show when={song()}>
												{(current) => (
													<SongContextMenu
														queueIndex={
															isAutoplayRow() ? undefined : itemIndex()
														}
														song={current()}
													>
														<button
															class={cn(
																"group absolute inset-x-0 grid grid-cols-[1.5rem_2.5rem_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
																isCurrent()
																	? "bg-primary/9"
																	: "hover:bg-foreground/5",
															)}
															onClick={() => {
																if (isAutoplayRow()) {
																	player.playAutoplayAt(itemIndex());
																} else {
																	player.play(current());
																}
															}}
															ref={(el) => {
																// Deliberate snapshot: the row's index is
																// fixed for the row's lifetime (the For is
																// keyed by it) and refs run untracked.
																rowVirtualizer.measureRow(el, untrack(index));
															}}
															style={`transform: translateY(${vrow().start}px)`}
															type="button"
														>
															<span class="relative grid place-items-center">
																<Show
																	fallback={
																		<span class="font-mono text-[10px] text-muted-foreground/50 transition-opacity duration-150 group-hover:opacity-0">
																			{isAutoplayRow()
																				? player.queue().length +
																					itemIndex() +
																					1
																				: itemIndex() + 1}
																		</span>
																	}
																	when={isCurrent()}
																>
																	<EqualizerBars
																		class="size-3.5 text-primary"
																		playing={controls.isPlaying()}
																	/>
																</Show>
															</span>
															<Show
																fallback={
																	<div class="size-10 rounded-md bg-muted" />
																}
																when={current().thumbnail}
															>
																{(thumbnail) => (
																	<img
																		alt=""
																		class="size-10 rounded-md border border-foreground/10 object-cover"
																		loading="lazy"
																		src={proxiedImageUrl(thumbnail())}
																	/>
																)}
															</Show>
															<div class="min-w-0">
																<p
																	class={cn(
																		"truncate text-sm font-medium",
																		isCurrent() && "text-primary",
																	)}
																>
																	<SongTitle
																		artist={current().artist}
																		keepTitle={current().upload}
																		title={current().title}
																	/>
																</p>
																<p class="truncate text-xs text-muted-foreground">
																	<ArtistLinks song={current()} />
																</p>
															</div>
															<div class="flex items-center gap-2 pr-1">
																<DownloadedBadge songId={current().id} />
																<Show when={current().duration}>
																	{(duration) => (
																		<span class="font-mono text-[10px] text-muted-foreground/60 tabular-nums">
																			{duration()}
																		</span>
																	)}
																</Show>
															</div>
														</button>
													</SongContextMenu>
												)}
											</Show>
										}
										when={showSeparator() && index() === separatorIndex()}
									>
										<div
											class="absolute inset-x-0 flex items-center gap-2 px-2"
											style={`height: ${vrow().size}px; transform: translateY(${vrow().start}px)`}
										>
											<span class="text-[10px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
												Autoplay
											</span>
											<span class="h-px flex-1 bg-foreground/10" />
										</div>
									</Show>
								);
							}}
						</For>
					</div>
				</Show>
			</div>
		</aside>
	);
}
