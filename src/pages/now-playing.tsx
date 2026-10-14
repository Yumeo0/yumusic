import {
	ChevronDown,
	ChevronsUp,
	ListMusic,
	MicVocal,
	Music2,
	Pause,
	Play,
	SkipBack,
	SkipForward,
} from "@lucide/solid";
import type { JSX } from "@solidjs/web";
import { type Accessor, createEffect, createSignal, For, Show } from "solid-js";
import { LyricsPanel } from "@/components/lyrics/lyrics";
import { VolumeControl } from "@/components/player/volume-control";
import { ProgressBar } from "@/components/player/waveform";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useLyricsMorph } from "@/lib/motion/lyrics-motion";
import {
	mergeTouchHandlers,
	type QueueGestureCheck,
	useQueueDragGesture,
	useQueueSheetGesture,
} from "@/lib/motion/queue-drag";
import { setQueueRevealTarget } from "@/lib/player/player-ui";
import { useMediaTime } from "@/lib/utils/hooks";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import {
	cn,
	coverViewBox,
	formatDuration,
	formatTime,
} from "@/lib/utils/utils";

interface NowPlayingPageProps {
	onClose: () => void;
	isQueueOpen: boolean;
	onToggleQueue: () => void;
}

/**
 * Fullscreen "Now Playing" experience.
 * Left: lyrics. Right: artwork, transport, seek. Tinted with the accent
 * color derived from the current song's thumbnail.
 */
export function NowPlayingPage(props: NowPlayingPageProps) {
	const player = usePlayer();
	const controls = usePlayerControls();

	// Mobile: lyrics are opt-in via the transport toggle. Desktop always
	// shows the lyrics column — the state only affects max-md classes.
	const [showLyrics, setShowLyrics] = createSignal(false);

	// Swipe gestures on the player itself. The queue is closed: swiping up
	// from anywhere opens its sheet. The queue is open: dragging up or down
	// anywhere above the sheet drags it between detents. Both skip the
	// scrollable lyrics column, which keeps scrolling natively.
	const canStartQueueGesture: QueueGestureCheck = (event) =>
		!(event.target instanceof Element) ||
		!event.target.closest("[data-swipe-dismiss-ignore]");
	let stageEl!: HTMLDivElement;
	let stageTitleEl!: HTMLDivElement;
	let stageControlsEl!: HTMLDivElement;
	let stagePillEl!: HTMLDivElement;
	const swipeHandlers = useQueueDragGesture(canStartQueueGesture);
	const sheetHandlers = useQueueSheetGesture(canStartQueueGesture);
	const touchHandlers = mergeTouchHandlers(swipeHandlers, sheetHandlers);

	// Measure the morphing stage's sub-elements so its closed-state geometry
	// reproduces the original flex layout exactly (see useMorphMetrics).
	// The song is part of the activation: the page is mounted before a song
	// exists (rendering nothing), so the stage only appears — and must be
	// measured — once the song arrives.
	useMorphMetrics(() => !showLyrics() && player.currentSong() !== null, {
		controls: () => stageControlsEl,
		pill: () => stagePillEl,
		stage: () => stageEl,
		title: () => stageTitleEl,
	});

	// Glide between the two mobile layouts when lyrics are toggled. Declared
	// after useMorphMetrics so the stage is measured before it is animated.
	let pageEl!: HTMLDivElement;
	const prepareLyricsMorph = useLyricsMorph(() => pageEl, showLyrics);
	const toggleLyrics = () => {
		prepareLyricsMorph();
		setShowLyrics((value) => !value);
	};

	// Route the drag blend at the stage element (not the document root) so a
	// per-frame write only invalidates the stage's own subtree styles.
	const attachStage = (element: HTMLDivElement) => {
		stageEl = element;
		setQueueRevealTarget(element);
	};

	// Tapping opens the sheet; swiping up anywhere below the progress bar
	// drags it in. Rendered inside the morphing stage on mobile, and as a
	// plain section child in mobile lyrics mode.
	const queuePill = () => (
		<button
			aria-label="Open queue"
			class="mx-auto flex items-center gap-1.5 rounded-full bg-foreground/6 px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground active:scale-95 md:hidden"
			data-np-queue-pill
			onClick={() => props.onToggleQueue()}
			type="button"
		>
			<ChevronsUp class="size-3.5" />
			Queue
		</button>
	);

	return (
		<Show when={player.currentSong()}>
			{(song) => {
				// The up-next stack tucks up to three upcoming tracks under the next
				// card and slides them out on hover. It reserves no height: the stack
				// grows to fit its cards when revealed, pushing the content below it.
				// When the queue has nothing left, the section falls back to the
				// autoplay radio so it shows what will actually play next.
				const hasQueuedNext = () =>
					player.queue().length > player.currentIndex() + 1;
				const upNext = () =>
					hasQueuedNext()
						? player
								.queue()
								.slice(player.currentIndex() + 1, player.currentIndex() + 4)
						: player.autoplayTracks().slice(0, 3);
				const upNextTucked = () => upNext().slice(1);
				const upNextIsAutoplay = () => !hasQueuedNext() && upNext().length > 0;

				// Static geometry for the morphing stage. The three measured heights
				// are filled in by useMorphMetrics; everything else derives from the
				// viewport. Closed cover top centers the cover + title block in the
				// space above the controls (which themselves rest one pill-height +
				// gap above the bottom), matching the flex layout this replaced. The
				// open cover ignores the page padding: it runs from the very top of
				// the viewport down to the queue sheet's half detent (50vh), edge to
				// edge, with no seam at the queue.
				const morphVars = {
					"--np-cover-open-h": "50vh",
					"--np-cover-size": "min(34vh, 280px)",
					"--np-cover-top":
						"calc((100% - 48px - var(--np-ctrl-h, 0px) - var(--np-pill-h, 0px) - var(--np-cover-size) - var(--np-title-h, 0px)) / 2)",
					"--np-cover-top-open": "calc(-1 * max(3.5rem, var(--safe-area-top)))",
					"--np-title-top-closed":
						"calc(var(--np-cover-top) + var(--np-cover-size) + 16px)",
					"--np-title-top-open":
						"calc(var(--np-cover-top-open) + var(--np-cover-open-h) - 24px - var(--np-ctrl-h, 0px) - var(--np-title-h, 0px))",
				} as JSX.CSSProperties;

				return (
					<div
						class="relative flex h-full touch-none flex-col overflow-hidden"
						data-np-page
						ref={pageEl}
						{...touchHandlers}
					>
						{/* Page background + blurred cover. The dismiss gesture slides the
						    whole page away like a sheet (no fading anywhere), so the layer
						    clips its own scaled-up artwork once the page's overflow is
						    released mid-drag. Re-fades on track change. */}
						<div
							aria-hidden="true"
							class="absolute inset-0 overflow-hidden bg-background"
							data-np-backdrop
						>
							<Show when={song().thumbnail}>
								{(thumbnail) => (
									<Show keyed when={song().id}>
										{(_id) => (
											<div class="animate-in fade-in absolute inset-0 duration-700">
												<img
													alt=""
													class="size-full scale-125 object-cover opacity-30 blur-3xl"
													src={proxiedImageUrl(thumbnail())}
												/>
												<div class="absolute inset-0 bg-background/60" />
											</div>
										)}
									</Show>
								)}
							</Show>
						</div>

						{/* Top-right actions: queue + close. The queue button stays visible
						    on mobile — bottom-edge swipes belong to Android's gesture
						    navigation, so the artwork swipe alone is not reliable. While
						    the player is dismissed they shrink away (scale, not opacity)
						    as the page slides off. */}
						<div
							class="absolute top-12 right-6 z-20 max-md:top-[max(2.75rem,var(--safe-area-top))] max-md:right-4 flex items-center gap-2"
							data-np-chrome
							style={{
								transform: "scale(max(0, 1 - var(--np-dismiss, 0) * 3))",
								"transform-origin": "top right",
							}}
						>
							<button
								aria-label="Toggle queue"
								class={cn(
									"grid size-9 place-items-center rounded-full transition-colors duration-200",
									props.isQueueOpen
										? "bg-primary/15 text-primary"
										: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
								)}
								onClick={props.onToggleQueue}
								title="Queue"
								type="button"
							>
								<ListMusic class="size-5" />
							</button>
							<button
								aria-label="Close Now Playing"
								class="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
								onClick={props.onClose}
								type="button"
							>
								<ChevronDown class="size-5" />
							</button>
						</div>

						{/* Body: art + controls first, two columns from md up. On mobile
						    lyrics are hidden until toggled — they then take the upper
						    part of the screen while the artwork block shrinks below.
						    Fixed heights keep the cover and controls from shifting when
						    lyrics load or scroll. */}
						<main class="relative z-10 flex min-h-0 flex-1 flex-col gap-4 px-6 pt-14 pb-8 max-md:pt-[max(3.5rem,var(--safe-area-top))] max-md:pb-[calc(2rem+var(--safe-area-bottom))] sm:px-10 md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-6 lg:gap-14">
							{/* Lyrics + Up next. On mobile the top padding clears the
							    overlay's queue/close buttons so the provider toggle in the
							    lyrics header doesn't sit under them. */}
							<section
								class={cn(
									"flex min-h-0 touch-pan-y flex-col max-md:pt-10 md:order-1 md:h-auto md:min-h-0",
									showLyrics()
										? "order-1 max-md:h-auto max-md:flex-1"
										: "order-2 h-36 shrink-0 max-md:hidden",
								)}
								data-np-lyrics-section
								data-swipe-dismiss-ignore
							>
								{/* Shrinks as the up-next stack below expands on hover */}
								<div class="min-h-0 flex-1">
									<NowPlayingLyrics
										knownDuration={player.duration}
										song={song()}
										videoElement={player.videoElement}
									/>
								</div>

								{/* Up next — the next card plus ~3 more tucked underneath it,
								    slid out on hover. Desktop only (phones use the sheet). */}
								<div class="mx-auto mt-4 w-full max-w-xl shrink-0 max-md:hidden">
									<div class="mb-1.5 flex items-baseline justify-between">
										<p class="text-xs font-medium text-muted-foreground">
											Up next
										</p>
										<Show
											fallback={
												<Show when={upNextIsAutoplay()}>
													<p class="text-[11px] text-muted-foreground/60">
														Autoplay
													</p>
												</Show>
											}
											when={hasQueuedNext()}
										>
											<p class="text-[11px] text-muted-foreground/60">
												{player.queue().length - player.currentIndex() - 1} in
												queue
											</p>
										</Show>
									</div>
									<Show
										fallback={
											<p class="p-1.5 text-sm text-muted-foreground/70">
												Queue is empty.
											</p>
										}
										when={upNext().length > 0}
									>
										<div class="group/upn">
											<div class="relative z-20">
												<QueueRow
													onPlay={() =>
														hasQueuedNext()
															? void player.play(upNext()[0])
															: player.playAutoplayAt(0)
													}
													queueIndex={
														hasQueuedNext()
															? player.currentIndex() + 1
															: undefined
													}
													song={upNext()[0]}
												/>
											</div>
											<div>
												<For each={upNextTucked()} keyed={(song) => song.id}>
													{(tucked, k) => (
														<div
															class={cn(
																"relative -mt-11.5 origin-top scale-[0.97] transition-all duration-300 ease-out group-hover/upn:mt-1.5 group-hover/upn:scale-100",
															)}
															style={{
																"transition-delay": `${k() * 60}ms`,
																"z-index": 10 - k(),
															}}
														>
															<QueueRow
																onPlay={() =>
																	hasQueuedNext()
																		? void player.play(tucked())
																		: player.playAutoplayAt(k() + 1)
																}
																queueIndex={
																	hasQueuedNext()
																		? player.currentIndex() + 2 + k()
																		: undefined
																}
																song={tucked()}
															/>
														</div>
													)}
												</For>
											</div>
										</div>
									</Show>
								</div>
							</section>

							{/* Artwork + controls. On mobile a single stage morphs between the
							    queue-closed layout (square cover centered, title under it,
							    controls at the screen bottom) and the queue-up layout
							    (full-bleed cover with the title, seek bar and transport over
							    its bottom gradient). The blend factor --queue-reveal is
							    written by the queue drag gestures, so the stage tracks the
							    finger; programmatic opens/closes ease over the sheet's
							    300ms travel. On desktop both stay stacked and centered. */}
							<section
								class={cn(
									"order-1 flex min-h-0 flex-1 flex-col items-center gap-4 md:order-2 md:justify-center md:gap-6",
									showLyrics() && "max-md:flex-none",
								)}
							>
								{/* Mobile morphing stage. The outer box bleeds past the page
								    padding so the open cover reaches the screen edges; the
								    cover, title, controls and queue pill are positioned
								    against it and interpolate with --queue-reveal. */}
								<Show when={!showLyrics()}>
									<div
										class="np-morph relative -mx-6 flex min-h-0 w-[calc(100%+3rem)] flex-1 flex-col items-center sm:-mx-10 sm:w-[calc(100%+5rem)] md:hidden"
										data-np-morph-stage
										ref={attachStage}
										style={morphVars}
									>
										{/* Closed cover's glow + shadow, pinned to the closed
										    geometry, faded out as the cover expands (queue)
										    and shrunk to nothing as the player minimizes: a
										    blur this large repainting on every resized frame
										    is what makes the drag stutter. */}
										<div
											aria-hidden="true"
											class="np-morph pointer-events-none absolute transition-[opacity,transform] duration-300 ease-out"
											data-np-cover-glow
											style={{
												"border-radius": "16px",
												height: "var(--np-cover-size)",
												left: "calc((100% - var(--np-cover-size)) / 2)",
												opacity: "calc(1 - var(--queue-reveal, 0))",
												top: "var(--np-cover-top)",
												transform:
													"scale(max(0, 1 - var(--np-dismiss, 0) * 2.5))",
												width: "var(--np-cover-size)",
											}}
										>
											<div class="absolute -inset-7 rounded-[2.5rem] bg-primary/20 blur-3xl" />
											<div class="absolute inset-0 rounded-2xl shadow-[0_24px_70px_-20px_oklch(0_0_0/0.7)]" />
										</div>

										{/* Cover: grows from the centered square to the
										    edge-to-edge rectangle running from the top of the
										    viewport down to the queue's half detent, and
										    shrinks onto the mini-player thumbnail while the
										    player is dismissed — pinned in place while the
										    page itself slides away. */}
										<SongContextMenu song={song()}>
											<div
												class="np-morph absolute touch-none select-none transition-[left,top,width,height] duration-300 ease-out"
												data-np-cover
												style={{
													height:
														"calc((var(--np-cover-size) + (var(--np-cover-open-h) - var(--np-cover-size)) * var(--queue-reveal, 0)) * (1 - var(--np-dismiss, 0)) + var(--np-min-cover-size, 0px) * var(--np-dismiss, 0))",
													left: "calc(((100% - var(--np-cover-size)) * (1 - var(--queue-reveal, 0)) / 2) * (1 - var(--np-dismiss, 0)) + var(--np-min-cover-left, 0px) * var(--np-dismiss, 0))",
													top: "calc((var(--np-cover-top) * (1 - var(--queue-reveal, 0)) + var(--np-cover-top-open) * var(--queue-reveal, 0)) * (1 - var(--np-dismiss, 0)) + var(--np-min-cover-top, 0px) * var(--np-dismiss, 0) - var(--np-slide, 0px))",
													width:
														"calc((var(--np-cover-size) + (100% - var(--np-cover-size)) * var(--queue-reveal, 0)) * (1 - var(--np-dismiss, 0)) + var(--np-min-cover-size, 0px) * var(--np-dismiss, 0))",
												}}
											>
												<div
													class="np-morph relative size-full overflow-hidden bg-card transition-[border-radius] duration-300 ease-out"
													style={{
														"border-radius":
															"calc((16px * (1 - var(--queue-reveal, 0))) * (1 - var(--np-dismiss, 0)) + 6px * var(--np-dismiss, 0))",
													}}
												>
													<Show
														fallback={
															<div class="absolute inset-0 grid place-items-center">
																<Music2 class="size-14 text-muted-foreground" />
															</div>
														}
														when={song().thumbnail}
													>
														{(thumbnail) => (
															<Show keyed when={song().id}>
																{(_id) => (
																	<img
																		alt={song().title}
																		class="animate-track-in absolute inset-0 size-full object-cover"
																		draggable="false"
																		src={proxiedImageUrl(thumbnail())}
																		style={
																			{
																				"object-view-box": coverViewBox(
																					thumbnail(),
																				),
																			} as JSX.CSSProperties
																		}
																	/>
																)}
															</Show>
														)}
													</Show>
													{/* Hairline edge of the floating square, faded out
												    once the cover reaches the screen edges. */}
													<div
														aria-hidden="true"
														class="np-morph pointer-events-none absolute inset-0 ring-1 ring-foreground/10 ring-inset"
														style={{
															"border-radius": "inherit",
															opacity: "calc(1 - var(--queue-reveal, 0))",
														}}
													/>
													<div
														class="np-morph pointer-events-none absolute inset-x-0 bottom-0 h-1/2 max-h-72 bg-gradient-to-t from-background via-background/75 to-transparent transition-[opacity] duration-300 ease-out"
														style={{ opacity: "var(--queue-reveal, 0)" }}
													/>
												</div>
											</div>
										</SongContextMenu>

										{/* Title: slides from under the cover to the top of the
										    seek + transport stack. The title and artist lines
										    inside morph onto the mini player's lines. */}
										<div
											class="np-morph absolute inset-x-0 px-6 transition-[top] duration-300 ease-out sm:px-10"
											ref={stageTitleEl}
											style={{
												top: "calc(var(--np-title-top-closed) + (var(--np-title-top-open) - var(--np-title-top-closed)) * var(--queue-reveal, 0))",
											}}
										>
											<TrackHeading class="text-center" song={song()} />
										</div>

										{/* Seek + transport: rise from the screen bottom onto
										    the artwork, ending just above the queue. The seek
										    bar and the transport row inside morph onto the
										    mini player's progress strip and controls. */}
										<div
											class="np-morph absolute inset-x-0 flex flex-col items-center gap-3 px-6 transition-[bottom] duration-300 ease-out sm:px-10"
											ref={stageControlsEl}
											style={{
												bottom:
													"calc(var(--np-pill-h, 0px) + 16px + (100% - var(--np-cover-open-h) - var(--np-cover-top-open) + 12px - var(--np-pill-h, 0px) - 16px) * var(--queue-reveal, 0))",
											}}
										>
											<div class="w-full max-w-md">
												<NowPlayingSeek
													knownDuration={player.duration}
													songId={() => song().id}
													videoElement={player.videoElement}
												/>
											</div>
											<TransportRow
												hasNext={player.hasNext()}
												hasPrevious={player.hasPrevious()}
												isPlaying={controls.isPlaying()}
												onNext={() => void player.next()}
												onPrevious={() => void player.previous()}
												onToggle={controls.toggle}
												onToggleLyrics={toggleLyrics}
												showLyrics={showLyrics()}
											/>
										</div>

										{/* Queue pill: slides up and tucks in behind the queue
										    sheet, whose edge meets the cover while it is up.
										    It slides off with the page while dismissing. */}
										<div
											class="np-morph absolute inset-x-0 flex justify-center transition-[bottom] duration-300 ease-out"
											ref={stagePillEl}
											style={{
												bottom:
													"calc((100% - var(--np-cover-open-h) - var(--np-cover-top-open) - var(--np-pill-h, 0px)) * var(--queue-reveal, 0))",
											}}
										>
											{queuePill()}
										</div>
									</div>
								</Show>

								{/* Mobile lyrics mode: compact artwork + title row. */}
								<Show when={showLyrics()}>
									<div class="flex w-full items-center gap-4 md:hidden">
										<SongContextMenu song={song()}>
											<div
												class="np-morph shrink-0"
												data-np-cover
												style={morphStyle("--np-cover")}
											>
												<Show
													fallback={
														<div class="grid size-16 shrink-0 place-items-center rounded-xl border border-foreground/10 bg-card">
															<Music2 class="size-8 text-muted-foreground" />
														</div>
													}
													when={song().thumbnail}
												>
													{(thumbnail) => (
														<img
															alt=""
															class="size-16 shrink-0 rounded-xl border border-foreground/10 object-cover"
															draggable="false"
															src={proxiedImageUrl(thumbnail())}
														/>
													)}
												</Show>
											</div>
										</SongContextMenu>
										<TrackHeading
											class="min-w-0 flex-1 text-left"
											song={song()}
										/>
									</div>
								</Show>

								{/* Desktop: centered artwork above the title. */}
								<div class="hidden w-full flex-col items-center gap-6 md:flex">
									<SongContextMenu song={song()}>
										<div
											class="np-morph group relative touch-none select-none"
											data-np-cover
											style={morphStyle("--np-cover")}
										>
											<div
												aria-hidden="true"
												class="absolute -inset-7 rounded-[2.5rem] bg-primary/20 blur-3xl"
												style={{
													transform:
														"scale(max(0, 1 - var(--np-dismiss, 0) * 2.5))",
												}}
											/>
											<Show
												fallback={
													<div class="relative grid aspect-square w-[min(40vh,320px)] place-items-center rounded-2xl border border-foreground/10 bg-card">
														<Music2 class="size-14 text-muted-foreground" />
													</div>
												}
												when={song().thumbnail}
											>
												{(thumbnail) => (
													<Show keyed when={song().id}>
														{(_id) => (
															<img
																alt={song().title}
																class="animate-track-in relative aspect-square w-[min(40vh,320px)] rounded-2xl border border-foreground/10 object-cover shadow-[0_24px_70px_-20px_oklch(0_0_0/0.7)]"
																draggable="false"
																src={proxiedImageUrl(thumbnail())}
															/>
														)}
													</Show>
												)}
											</Show>
										</div>
									</SongContextMenu>
									<TrackHeading class="text-center" song={song()} />
								</div>

								{/* Seek + transport — part of the hero on mobile, standalone on
							    desktop and in mobile lyrics mode. Swipes starting here or
							    above are ignored by the queue-opening gesture. */}
								<div
									class={cn(
										"flex w-full flex-col items-center gap-4 md:gap-6",
										!showLyrics() && "max-md:hidden",
									)}
								>
									<div class="w-full max-w-md">
										<NowPlayingSeek
											knownDuration={player.duration}
											songId={() => song().id}
											videoElement={player.videoElement}
										/>
									</div>
									<TransportRow
										hasNext={player.hasNext()}
										hasPrevious={player.hasPrevious()}
										isPlaying={controls.isPlaying()}
										onNext={() => void player.next()}
										onPrevious={() => void player.previous()}
										onToggle={controls.toggle}
										onToggleLyrics={toggleLyrics}
										showLyrics={showLyrics()}
									/>
								</div>

								{/* Queue affordance (mobile): only rendered as a plain child
								    in lyrics mode — the morphing stage carries its own pill. */}
								<Show when={showLyrics()}>{queuePill()}</Show>
							</section>
						</main>
					</div>
				);
			}}
		</Show>
	);
}

/**
 * Measures the morphing stage's title, controls and queue pill into CSS
 * variables, so its closed-state geometry reproduces the original flex layout
 * at any viewport, font size and safe-area inset. Runs before paint and again
 * whenever one of the elements resizes (breakpoints, font loads, rotation).
 */
function useMorphMetrics(
	active: Accessor<boolean>,
	getRefs: {
		stage: () => HTMLDivElement | null;
		title: () => HTMLDivElement | null;
		controls: () => HTMLDivElement | null;
		pill: () => HTMLDivElement | null;
	},
) {
	createEffect(
		() => active(),
		(isActive) => {
			if (!isActive) return;
			const stageEl = getRefs.stage();
			if (!stageEl) return;
			const update = () => {
				stageEl.style.setProperty(
					"--np-title-h",
					`${getRefs.title()?.offsetHeight ?? 0}px`,
				);
				stageEl.style.setProperty(
					"--np-ctrl-h",
					`${getRefs.controls()?.offsetHeight ?? 0}px`,
				);
				stageEl.style.setProperty(
					"--np-pill-h",
					`${getRefs.pill()?.offsetHeight ?? 0}px`,
				);
			};
			update();
			if (typeof ResizeObserver === "undefined") {
				window.addEventListener("resize", update);
				return () => window.removeEventListener("resize", update);
			}
			const observer = new ResizeObserver(update);
			for (const getRef of [getRefs.title, getRefs.controls, getRefs.pill]) {
				const element = getRef();
				if (element) observer.observe(element);
			}
			window.addEventListener("resize", update);
			return () => {
				observer.disconnect();
				window.removeEventListener("resize", update);
			};
		},
	);
}

/**
 * Transform for one dismiss-morph pair: `translate(t * d) scale(1 + (s - 1) * d)`
 * about the element's top-left, with the page slide compensated so the element
 * stays put while the page leaves. Targets are measured per pair (see
 * measureDismissGeometry); without them this is the identity.
 */
function morphStyle(prefix: string): JSX.CSSProperties {
	return {
		transform: `translate(calc(var(${prefix}-tx, 0px) * var(--np-dismiss, 0)), calc(var(${prefix}-ty, 0px) * var(--np-dismiss, 0) - var(--np-slide, 0px))) scale(calc(1 + (var(${prefix}-s, 1) - 1) * var(--np-dismiss, 0)))`,
		"transform-origin": "0 0",
	};
}

/** Track title + artist credit, shared by the mobile stage, compact row and
 * desktop layout. The two lines are wrapped so the dismiss morph can move and
 * scale each one onto its mini-player counterpart independently. */
function TrackHeading(props: { song: Song; class?: string }) {
	return (
		<div class={cn("max-w-full", props.class)}>
			<div
				class="np-morph transition-transform duration-300 ease-out"
				data-np-title-line
				style={morphStyle("--np-title")}
			>
				<Show keyed when={props.song.id}>
					{(_id) => (
						<h1 class="animate-track-in flex items-center justify-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
							<span class="min-w-0 truncate">
								<SongTitle
									artist={props.song.artist}
									keepTitle={props.song.upload}
									title={props.song.title}
								/>
							</span>
							<DownloadedBadge songId={props.song.id} />
						</h1>
					)}
				</Show>
			</div>
			<div
				class="np-morph transition-transform duration-300 ease-out"
				data-np-artist-line
				style={morphStyle("--np-artist")}
			>
				<Show keyed when={props.song.id}>
					{(_id) => (
						<p
							class="animate-track-in mt-1 truncate text-base text-muted-foreground"
							style={{ "animation-delay": "60ms" }}
						>
							<ArtistLinks song={props.song} />
						</p>
					)}
				</Show>
			</div>
		</div>
	);
}

/** Transport controls + lyrics toggle + desktop volume. */
function TransportRow(props: {
	hasNext: boolean;
	hasPrevious: boolean;
	isPlaying: boolean;
	onNext: () => void;
	onPrevious: () => void;
	onToggle: () => void;
	onToggleLyrics: () => void;
	showLyrics: boolean;
}) {
	// Width the row needs before the volume slider may expand sideways: the
	// transport (176px) plus the expanded volume control (124px) on both
	// sides. Narrower rows get the vertical popover instead.
	let rowEl!: HTMLDivElement;
	const [narrow, setNarrow] = createSignal(false);
	createEffect(
		() => rowEl,
		(row) => {
			if (!row) return;
			const update = () => setNarrow(row.clientWidth < 440);
			update();
			if (typeof ResizeObserver === "undefined") {
				window.addEventListener("resize", update);
				return () => window.removeEventListener("resize", update);
			}
			const observer = new ResizeObserver(update);
			observer.observe(row);
			return () => observer.disconnect();
		},
	);

	return (
		<div
			class="grid w-full max-w-md grid-cols-[1fr_auto_1fr] items-center"
			ref={rowEl}
		>
			<div class="col-start-2 row-start-1 flex items-center gap-4">
				<button
					aria-label="Previous"
					class="np-morph grid size-11 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 active:origin-center! disabled:pointer-events-none disabled:opacity-25"
					data-np-prev
					disabled={!props.hasPrevious}
					onClick={props.onPrevious}
					style={morphStyle("--np-prev")}
					type="button"
				>
					<SkipBack class="size-5.5 fill-current" />
				</button>
				<button
					aria-label={props.isPlaying ? "Pause" : "Play"}
					class="np-morph grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_24px_-6px_color-mix(in_oklab,var(--primary)_65%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-90 active:origin-center!"
					data-np-play
					onClick={props.onToggle}
					style={morphStyle("--np-play")}
					type="button"
				>
					<Show
						fallback={
							<Play class="size-6 -translate-x-[4.1667%] fill-current" />
						}
						when={props.isPlaying}
					>
						<Pause class="size-6 fill-current" />
					</Show>
				</button>
				<button
					aria-label="Next"
					class="np-morph grid size-11 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 active:origin-center! disabled:pointer-events-none disabled:opacity-25"
					data-np-next
					disabled={!props.hasNext}
					onClick={props.onNext}
					style={morphStyle("--np-next")}
					type="button"
				>
					<SkipForward class="size-5.5 fill-current" />
				</button>
			</div>
			{/* Lyrics toggle — mobile layout only, anchored to the row's left
			    edge so the transport stays centered. It shrinks out through
			    the left edge (motion, no fade) while the player minimizes so
			    it never lands on the mini player's controls. */}
			<button
				aria-label="Toggle lyrics"
				class={cn(
					"np-morph col-start-1 row-start-1 grid size-11 place-items-center justify-self-start rounded-full transition-colors duration-200 md:hidden",
					props.showLyrics
						? "bg-primary/15 text-primary"
						: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
				)}
				data-np-lyrics
				onClick={props.onToggleLyrics}
				style={{
					transform:
						"translateX(calc(var(--np-dismiss, 0) * -70px)) scale(max(0, 1 - var(--np-dismiss, 0) * 2.2))",
				}}
				title="Lyrics"
				type="button"
			>
				<MicVocal class="size-5" />
			</button>
			{/* Volume — expands leftward on hover, anchored to the row's right
			    edge. Its own grid track keeps the slider from ever clipping
			    the transport; when the row is too narrow for that, it pops up
			    vertically over a backdrop instead. Hidden on touch devices,
			    where the hardware volume keys apply, but shown on narrow
			    desktop windows too. */}
			<VolumeControl
				class="col-start-3 row-start-1 justify-self-end pointer-coarse:hidden"
				reverse
				vertical={narrow()}
			/>
		</div>
	);
}

/**
 * Seek bar + timecodes. Isolated so the several-times-a-second timeupdate
 * only touches this strip, not the backdrop, artwork and up-next rows.
 */
function NowPlayingSeek(props: {
	songId: Accessor<string>;
	videoElement: Accessor<HTMLVideoElement | null>;
	knownDuration: Accessor<number>;
}) {
	const { currentTime, duration } = useMediaTime(
		() => props.videoElement(),
		() => props.songId(),
		() => props.knownDuration(),
	);
	const handleSeek = (percent: number) => {
		const videoEl = props.videoElement();
		const total = duration();
		if (videoEl && total > 0) {
			videoEl.currentTime = percent * total;
		}
	};
	return (
		<>
			<div
				class="np-morph transition-transform duration-300 ease-out"
				data-np-seek-bar
				style={{
					// Horizontal-only stretch onto the mini strip (see
					// measureDismissGeometry): the track keeps its thickness.
					transform:
						"translate(calc(var(--np-seek-tx, 0px) * var(--np-dismiss, 0)), calc(var(--np-seek-ty, 0px) * var(--np-dismiss, 0) - var(--np-slide, 0px))) scaleX(calc(1 + (var(--np-seek-sx, 1) - 1) * var(--np-dismiss, 0)))",
					"transform-origin": "0 0",
				}}
			>
				<ProgressBar
					onSeek={handleSeek}
					progress={duration() > 0 ? currentTime() / duration() : 0}
				/>
			</div>
			<div
				class="np-morph mt-0.5 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums transition-transform duration-300 ease-out"
				data-np-seek-times
				style={{
					transform: "scale(max(0, 1 - var(--np-dismiss, 0) * 2.5))",
				}}
			>
				<span>{formatTime(currentTime())}</span>
				<span>{formatDuration(duration())}</span>
			</div>
		</>
	);
}

/** Lyrics subscribe to the clock themselves so the fullscreen tree stays put. */
function NowPlayingLyrics(props: {
	song: Song;
	videoElement: Accessor<HTMLVideoElement | null>;
	knownDuration: Accessor<number>;
}) {
	const { currentTime, duration } = useMediaTime(
		() => props.videoElement(),
		() => props.song.id,
		() => props.knownDuration(),
	);
	// A getter-backed holder: the per-frame word fills always read the live
	// media element without the holder identity ever changing.
	const videoHolder = {
		get current() {
			return props.videoElement();
		},
	};
	const onSeekTime = (seconds: number) => {
		const videoEl = props.videoElement();
		if (videoEl) videoEl.currentTime = seconds;
	};
	return (
		<LyricsPanel
			artist={props.song.artist}
			class="mx-auto w-full max-w-xl"
			currentTime={currentTime()}
			duration={duration()}
			onSeekTime={onSeekTime}
			songId={props.song.id}
			title={props.song.title}
			videoRef={videoHolder}
		/>
	);
}

function QueueRow(props: {
	song: Song;
	onPlay: () => void;
	/** Queue position; omit for autoplay suggestions. */
	queueIndex?: number;
}) {
	return (
		<SongContextMenu queueIndex={props.queueIndex} song={props.song}>
			<button
				class="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-card/70 p-1.5 text-left shadow-[0_2px_12px_-4px_oklch(0_0_0/0.4)] backdrop-blur-sm transition-colors duration-200 hover:border-primary/40"
				onClick={props.onPlay}
				type="button"
			>
				<Show
					fallback={<div class="size-9 shrink-0 rounded-md bg-muted" />}
					when={props.song.thumbnail}
				>
					{(thumbnail) => (
						<img
							alt={props.song.title}
							class="size-9 shrink-0 rounded-md object-cover"
							loading="lazy"
							src={proxiedImageUrl(thumbnail())}
						/>
					)}
				</Show>
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">
						<SongTitle
							artist={props.song.artist}
							keepTitle={props.song.upload}
							title={props.song.title}
						/>
					</p>
					<p class="truncate text-xs text-muted-foreground">
						<ArtistLinks song={props.song} />
					</p>
				</div>
				<div class="flex items-center gap-2 pr-1">
					<DownloadedBadge songId={props.song.id} />
					<Show when={props.song.duration}>
						{(duration) => (
							<span class="font-mono text-[10px] text-muted-foreground/70">
								{duration()}
							</span>
						)}
					</Show>
				</div>
			</button>
		</SongContextMenu>
	);
}
