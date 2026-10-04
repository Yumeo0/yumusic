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
} from "lucide-react";
import {
	type CSSProperties,
	memo,
	type RefObject,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { ArtistLinks } from "@/components/artist-link";
import { LyricsPanel } from "@/components/lyrics";
import { SongContextMenu } from "@/components/song-menu";
import { SongTitle } from "@/components/song-title";
import { VolumeControl } from "@/components/volume-control";
import { ProgressBar } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useMediaTime } from "@/lib/hooks";
import { useLyricsMorph } from "@/lib/lyrics-motion";
import { setQueueRevealTarget } from "@/lib/player-ui";
import {
	mergeTouchHandlers,
	type QueueGestureCheck,
	useQueueDragGesture,
	useQueueSheetGesture,
} from "@/lib/queue-drag";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn, formatDuration, formatTime } from "@/lib/utils";

interface NowPlayingPageProps {
	onClose: () => void;
	isQueueOpen: boolean;
	onToggleQueue: () => void;
}

/**
 * Fullscreen "Now Playing" experience.
 * Left: lyrics. Right: artwork, transport, seek. Tinted with the accent
 * color derived from the current song's thumbnail.
 *
 * Memoized: the overlay re-renders on every open/close (it owns the
 * animation classes), but this page's props stay stable, so it doesn't
 * re-render — and neither does the lyrics tree — just to run the animation.
 */
export const NowPlayingPage = memo(function NowPlayingPage({
	onClose,
	isQueueOpen,
	onToggleQueue,
}: NowPlayingPageProps) {
	const {
		currentSong,
		queue,
		currentIndex,
		autoplayTracks,
		next,
		previous,
		hasNext,
		hasPrevious,
		play,
		playAutoplayAt,
		videoElementRef,
		duration: knownDuration,
	} = usePlayer();
	const { isPlaying, toggle } = usePlayerControls();

	// The up-next stack tucks up to three upcoming tracks under the next card
	// and slides them out on hover. It reserves no height: the stack grows to
	// fit its cards when revealed, pushing the content below it. When the queue
	// has nothing left, the section falls back to the autoplay radio so it
	// shows what will actually play next.
	const hasQueuedNext = queue.length > currentIndex + 1;
	const upNext = hasQueuedNext
		? queue.slice(currentIndex + 1, currentIndex + 4)
		: autoplayTracks.slice(0, 3);
	const upNextTucked = upNext.slice(1);
	const upNextIsAutoplay = !hasQueuedNext && upNext.length > 0;

	// Mobile: lyrics are opt-in via the transport toggle. Desktop always
	// shows the lyrics column — the state only affects max-md classes.
	const [showLyrics, setShowLyrics] = useState(false);

	// Swipe gestures on the player itself. The queue is closed: swiping up
	// from anywhere opens its sheet. The queue is open: dragging up or down
	// anywhere above the sheet drags it between detents. Both skip the
	// scrollable lyrics column, which keeps scrolling natively.
	const canStartQueueGesture = useCallback<QueueGestureCheck>(
		(event) =>
			!(event.target instanceof Element) ||
			!event.target.closest("[data-swipe-dismiss-ignore]"),
		[],
	);
	const stageRef = useRef<HTMLDivElement>(null);
	const stageTitleRef = useRef<HTMLDivElement>(null);
	const stageControlsRef = useRef<HTMLDivElement>(null);
	const stagePillRef = useRef<HTMLDivElement>(null);
	const swipeHandlers = useQueueDragGesture(canStartQueueGesture);
	const sheetHandlers = useQueueSheetGesture(canStartQueueGesture);
	const touchHandlers = mergeTouchHandlers(swipeHandlers, sheetHandlers);

	// Measure the morphing stage's sub-elements so its closed-state geometry
	// reproduces the original flex layout exactly (see useMorphMetrics).
	// `currentSong` is part of the activation: the page is mounted before a
	// song exists (returning null), so the stage only appears — and must be
	// measured — once the song arrives.
	useMorphMetrics(!showLyrics && currentSong !== null, {
		controls: stageControlsRef,
		pill: stagePillRef,
		stage: stageRef,
		title: stageTitleRef,
	});

	// Glide between the two mobile layouts when lyrics are toggled. Declared
	// after useMorphMetrics so the stage is measured before it is animated.
	const pageRef = useRef<HTMLDivElement>(null);
	const prepareLyricsMorph = useLyricsMorph(pageRef, showLyrics);
	const toggleLyrics = useCallback(() => {
		prepareLyricsMorph();
		setShowLyrics((value) => !value);
	}, [prepareLyricsMorph]);

	// Route the drag blend at the stage element (not the document root) so a
	// per-frame write only invalidates the stage's own subtree styles.
	const attachStage = useCallback((element: HTMLDivElement | null) => {
		stageRef.current = element;
		setQueueRevealTarget(element);
	}, []);

	if (!currentSong) return null;

	// Static geometry for the morphing stage. The three measured heights are
	// filled in by useMorphMetrics; everything else derives from the viewport.
	// Closed cover top centers the cover + title block in the space above the
	// controls (which themselves rest one pill-height + gap above the bottom),
	// matching the flex layout this replaced. The open cover ignores the page
	// padding: it runs from the very top of the viewport down to the queue
	// sheet's half detent (50vh), edge to edge, with no seam at the queue.
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
	} as CSSProperties;

	// Tapping opens the sheet; swiping up anywhere below the progress bar
	// drags it in. Rendered inside the morphing stage on mobile, and as a
	// plain section child in mobile lyrics mode.
	const queuePill = (
		<button
			aria-label="Open queue"
			className="mx-auto flex items-center gap-1.5 rounded-full bg-foreground/6 px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground active:scale-95 md:hidden"
			data-np-queue-pill
			onClick={() => onToggleQueue()}
			type="button"
		>
			<ChevronsUp className="size-3.5" />
			Queue
		</button>
	);

	return (
		<div
			className="relative flex h-full touch-none flex-col overflow-hidden"
			data-np-page
			ref={pageRef}
			{...touchHandlers}
		>
			{/* Page background + blurred cover. The dismiss gesture slides the
			    whole page away like a sheet (no fading anywhere), so the layer
			    clips its own scaled-up artwork once the page's overflow is
			    released mid-drag. Re-fades on track change. */}
			<div
				aria-hidden
				className="absolute inset-0 overflow-hidden bg-background"
				data-np-backdrop
			>
				{currentSong.thumbnail && (
					<div
						className="animate-in fade-in absolute inset-0 duration-700"
						key={`bg-${currentSong.id}`}
					>
						<img
							alt=""
							className="size-full scale-125 object-cover opacity-30 blur-3xl"
							src={proxiedImageUrl(currentSong.thumbnail)}
						/>
						<div className="absolute inset-0 bg-background/60" />
					</div>
				)}
			</div>

			{/* Top-right actions: queue + close. The queue button stays visible
			    on mobile — bottom-edge swipes belong to Android's gesture
			    navigation, so the artwork swipe alone is not reliable. While
			    the player is dismissed they shrink away (scale, not opacity)
			    as the page slides off. */}
			<div
				className="absolute top-12 right-6 z-20 max-md:top-[max(2.75rem,var(--safe-area-top))] max-md:right-4 flex items-center gap-2"
				data-np-chrome
				style={{
					transform: "scale(max(0, 1 - var(--np-dismiss, 0) * 3))",
					transformOrigin: "top right",
				}}
			>
				<button
					aria-label="Toggle queue"
					className={cn(
						"grid size-9 place-items-center rounded-full transition-colors duration-200",
						isQueueOpen
							? "bg-primary/15 text-primary"
							: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
					)}
					onClick={onToggleQueue}
					title="Queue"
					type="button"
				>
					<ListMusic className="size-5" />
				</button>
				<button
					aria-label="Close Now Playing"
					className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<ChevronDown className="size-5" />
				</button>
			</div>

			{/* Body: art + controls first, two columns from md up. On mobile
			    lyrics are hidden until toggled — they then take the upper
			    part of the screen while the artwork block shrinks below.
			    Fixed heights keep the cover and controls from shifting when
			    lyrics load or scroll. */}
			<main className="relative z-10 flex min-h-0 flex-1 flex-col gap-4 px-6 pt-14 pb-8 max-md:pt-[max(3.5rem,var(--safe-area-top))] max-md:pb-[calc(2rem+var(--safe-area-bottom))] sm:px-10 md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-6 lg:gap-14">
				{/* Lyrics + Up next. On mobile the top padding clears the
				    overlay's queue/close buttons so the provider toggle in the
				    lyrics header doesn't sit under them. */}
				<section
					className={cn(
						"flex min-h-0 touch-pan-y flex-col max-md:pt-10 md:order-1 md:h-auto md:min-h-0",
						showLyrics
							? "order-1 max-md:h-auto max-md:flex-1"
							: "order-2 h-36 shrink-0 max-md:hidden",
					)}
					data-np-lyrics-section
					data-swipe-dismiss-ignore
				>
					{/* Shrinks as the up-next stack below expands on hover */}
					<div className="min-h-0 flex-1">
						<NowPlayingLyrics
							knownDuration={knownDuration}
							song={currentSong}
							videoElementRef={videoElementRef}
						/>
					</div>

					{/* Up next — the next card plus ~3 more tucked underneath it,
					    slid out on hover. Desktop only (phones use the sheet). */}
					<div className="mx-auto mt-4 w-full max-w-xl shrink-0 max-md:hidden">
						<div className="mb-1.5 flex items-baseline justify-between">
							<p className="text-xs font-medium text-muted-foreground">
								Up next
							</p>
							{hasQueuedNext ? (
								<p className="text-[11px] text-muted-foreground/60">
									{queue.length - currentIndex - 1} in queue
								</p>
							) : upNextIsAutoplay ? (
								<p className="text-[11px] text-muted-foreground/60">Autoplay</p>
							) : null}
						</div>
						{upNext.length > 0 ? (
							<div className="group/upn">
								<div className="relative z-20">
									<QueueRow
										onPlay={() =>
											hasQueuedNext ? play(upNext[0]) : playAutoplayAt(0)
										}
										queueIndex={hasQueuedNext ? currentIndex + 1 : undefined}
										song={upNext[0]}
									/>
								</div>
								<div>
									{upNextTucked.map((song, k) => (
										<div
											className={cn(
												"relative -mt-11.5 origin-top scale-[0.97] transition-all duration-300 ease-out group-hover/upn:mt-1.5 group-hover/upn:scale-100",
											)}
											key={
												hasQueuedNext
													? `queue-${song.id}-${currentIndex + 2 + k}`
													: `auto-${song.id}-${k}`
											}
											style={{
												transitionDelay: `${k * 60}ms`,
												zIndex: 10 - k,
											}}
										>
											<QueueRow
												onPlay={() =>
													hasQueuedNext ? play(song) : playAutoplayAt(k + 1)
												}
												queueIndex={
													hasQueuedNext ? currentIndex + 2 + k : undefined
												}
												song={song}
											/>
										</div>
									))}
								</div>
							</div>
						) : (
							<p className="p-1.5 text-sm text-muted-foreground/70">
								Queue is empty.
							</p>
						)}
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
					className={cn(
						"order-1 flex min-h-0 flex-1 flex-col items-center gap-4 md:order-2 md:justify-center md:gap-6",
						showLyrics && "max-md:flex-none",
					)}
				>
					{/* Mobile morphing stage. The outer box bleeds past the page
					    padding so the open cover reaches the screen edges; the
					    cover, title, controls and queue pill are positioned
					    against it and interpolate with --queue-reveal. */}
					{!showLyrics && (
						<div
							className="np-morph relative -mx-6 flex min-h-0 w-[calc(100%+3rem)] flex-1 flex-col items-center sm:-mx-10 sm:w-[calc(100%+5rem)] md:hidden"
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
								aria-hidden
								className="np-morph pointer-events-none absolute transition-[opacity,transform] duration-300 ease-out"
								data-np-cover-glow
								style={{
									borderRadius: "16px",
									height: "var(--np-cover-size)",
									left: "calc((100% - var(--np-cover-size)) / 2)",
									opacity: "calc(1 - var(--queue-reveal, 0))",
									top: "var(--np-cover-top)",
									transform: "scale(max(0, 1 - var(--np-dismiss, 0) * 2.5))",
									width: "var(--np-cover-size)",
								}}
							>
								<div className="absolute -inset-7 rounded-[2.5rem] bg-primary/20 blur-3xl" />
								<div className="absolute inset-0 rounded-2xl shadow-[0_24px_70px_-20px_oklch(0_0_0/0.7)]" />
							</div>

							{/* Cover: grows from the centered square to the
							    edge-to-edge rectangle running from the top of the
							    viewport down to the queue's half detent, and
							    shrinks onto the mini-player thumbnail while the
							    player is dismissed — pinned in place while the
							    page itself slides away. */}
							<div
								className="np-morph absolute touch-none select-none transition-[left,top,width,height] duration-300 ease-out"
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
									className="np-morph relative size-full overflow-hidden bg-card transition-[border-radius] duration-300 ease-out"
									style={{
										borderRadius:
											"calc((16px * (1 - var(--queue-reveal, 0))) * (1 - var(--np-dismiss, 0)) + 6px * var(--np-dismiss, 0))",
									}}
								>
									{currentSong.thumbnail ? (
										<img
											alt={currentSong.title}
											className="animate-track-in absolute inset-0 size-full object-cover"
											draggable={false}
											key={`hero-${currentSong.id}`}
											src={proxiedImageUrl(currentSong.thumbnail)}
										/>
									) : (
										<div className="absolute inset-0 grid place-items-center">
											<Music2 className="size-14 text-muted-foreground" />
										</div>
									)}
									{/* Hairline edge of the floating square, faded out
									    once the cover reaches the screen edges. */}
									<div
										aria-hidden
										className="np-morph pointer-events-none absolute inset-0 ring-1 ring-foreground/10 ring-inset"
										style={{
											borderRadius: "inherit",
											opacity: "calc(1 - var(--queue-reveal, 0))",
										}}
									/>
									<div
										className="np-morph pointer-events-none absolute inset-x-0 bottom-0 h-1/2 max-h-72 bg-gradient-to-t from-background via-background/75 to-transparent transition-[opacity] duration-300 ease-out"
										style={{ opacity: "var(--queue-reveal, 0)" }}
									/>
								</div>
							</div>

							{/* Title: slides from under the cover to the top of the
							    seek + transport stack. The title and artist lines
							    inside morph onto the mini player's lines. */}
							<div
								className="np-morph absolute inset-x-0 px-6 transition-[top] duration-300 ease-out sm:px-10"
								ref={stageTitleRef}
								style={{
									top: "calc(var(--np-title-top-closed) + (var(--np-title-top-open) - var(--np-title-top-closed)) * var(--queue-reveal, 0))",
								}}
							>
								<TrackHeading className="text-center" song={currentSong} />
							</div>

							{/* Seek + transport: rise from the screen bottom onto
							    the artwork, ending just above the queue. The seek
							    bar and the transport row inside morph onto the
							    mini player's progress strip and controls. */}
							<div
								className="np-morph absolute inset-x-0 flex flex-col items-center gap-3 px-6 transition-[bottom] duration-300 ease-out sm:px-10"
								ref={stageControlsRef}
								style={{
									bottom:
										"calc(var(--np-pill-h, 0px) + 16px + (100% - var(--np-cover-open-h) - var(--np-cover-top-open) + 12px - var(--np-pill-h, 0px) - 16px) * var(--queue-reveal, 0))",
								}}
							>
								<div className="w-full max-w-md">
									<NowPlayingSeek
										knownDuration={knownDuration}
										songId={currentSong.id}
										videoElementRef={videoElementRef}
									/>
								</div>
								<TransportRow
									hasNext={hasNext}
									hasPrevious={hasPrevious}
									isPlaying={isPlaying}
									onNext={next}
									onPrevious={previous}
									onToggle={toggle}
									onToggleLyrics={toggleLyrics}
									showLyrics={showLyrics}
								/>
							</div>

							{/* Queue pill: slides up and tucks in behind the queue
							    sheet, whose edge meets the cover while it is up.
							    It slides off with the page while dismissing. */}
							<div
								className="np-morph absolute inset-x-0 flex justify-center transition-[bottom] duration-300 ease-out"
								ref={stagePillRef}
								style={{
									bottom:
										"calc((100% - var(--np-cover-open-h) - var(--np-cover-top-open) - var(--np-pill-h, 0px)) * var(--queue-reveal, 0))",
								}}
							>
								{queuePill}
							</div>
						</div>
					)}

					{/* Mobile lyrics mode: compact artwork + title row. */}
					{showLyrics && (
						<div className="flex w-full items-center gap-4 md:hidden">
							<div
								className="np-morph shrink-0"
								data-np-cover
								style={morphStyle("--np-cover")}
							>
								{currentSong.thumbnail ? (
									<img
										alt=""
										className="size-16 shrink-0 rounded-xl border border-foreground/10 object-cover"
										draggable={false}
										src={proxiedImageUrl(currentSong.thumbnail)}
									/>
								) : (
									<div className="grid size-16 shrink-0 place-items-center rounded-xl border border-foreground/10 bg-card">
										<Music2 className="size-8 text-muted-foreground" />
									</div>
								)}
							</div>
							<TrackHeading
								className="min-w-0 flex-1 text-left"
								song={currentSong}
							/>
						</div>
					)}

					{/* Desktop: centered artwork above the title. */}
					<div className="hidden w-full flex-col items-center gap-6 md:flex">
						<div
							className="np-morph group relative touch-none select-none"
							data-np-cover
							style={morphStyle("--np-cover")}
						>
							<div
								aria-hidden
								className="absolute -inset-7 rounded-[2.5rem] bg-primary/20 blur-3xl"
								style={{
									transform: "scale(max(0, 1 - var(--np-dismiss, 0) * 2.5))",
								}}
							/>
							{currentSong.thumbnail ? (
								<img
									alt={currentSong.title}
									className="animate-track-in relative aspect-square w-[min(40vh,320px)] rounded-2xl border border-foreground/10 object-cover shadow-[0_24px_70px_-20px_oklch(0_0_0/0.7)]"
									draggable={false}
									key={`art-${currentSong.id}`}
									src={proxiedImageUrl(currentSong.thumbnail)}
								/>
							) : (
								<div className="relative grid aspect-square w-[min(40vh,320px)] place-items-center rounded-2xl border border-foreground/10 bg-card">
									<Music2 className="size-14 text-muted-foreground" />
								</div>
							)}
						</div>
						<TrackHeading className="text-center" song={currentSong} />
					</div>

					{/* Seek + transport — part of the hero on mobile, standalone on
				    desktop and in mobile lyrics mode. Swipes starting here or
				    above are ignored by the queue-opening gesture. */}
					<div
						className={cn(
							"flex w-full flex-col items-center gap-4 md:gap-6",
							!showLyrics && "max-md:hidden",
						)}
					>
						<div className="w-full max-w-md">
							<NowPlayingSeek
								knownDuration={knownDuration}
								songId={currentSong.id}
								videoElementRef={videoElementRef}
							/>
						</div>
						<TransportRow
							hasNext={hasNext}
							hasPrevious={hasPrevious}
							isPlaying={isPlaying}
							onNext={next}
							onPrevious={previous}
							onToggle={toggle}
							onToggleLyrics={toggleLyrics}
							showLyrics={showLyrics}
						/>
					</div>

					{/* Queue affordance (mobile): only rendered as a plain child
					    in lyrics mode — the morphing stage carries its own pill. */}
					{showLyrics && queuePill}
				</section>
			</main>
		</div>
	);
});

type VideoRef = RefObject<HTMLVideoElement | null> | null;

/**
 * Measures the morphing stage's title, controls and queue pill into CSS
 * variables, so its closed-state geometry reproduces the original flex layout
 * at any viewport, font size and safe-area inset. Runs before paint and again
 * whenever one of the elements resizes (breakpoints, font loads, rotation).
 */
function useMorphMetrics(
	active: boolean,
	refs: {
		stage: RefObject<HTMLDivElement | null>;
		title: RefObject<HTMLDivElement | null>;
		controls: RefObject<HTMLDivElement | null>;
		pill: RefObject<HTMLDivElement | null>;
	},
) {
	const { stage, title, controls, pill } = refs;
	useLayoutEffect(() => {
		if (!active) return;
		const stageEl = stage.current;
		if (!stageEl) return;
		const update = () => {
			stageEl.style.setProperty(
				"--np-title-h",
				`${title.current?.offsetHeight ?? 0}px`,
			);
			stageEl.style.setProperty(
				"--np-ctrl-h",
				`${controls.current?.offsetHeight ?? 0}px`,
			);
			stageEl.style.setProperty(
				"--np-pill-h",
				`${pill.current?.offsetHeight ?? 0}px`,
			);
		};
		update();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", update);
			return () => window.removeEventListener("resize", update);
		}
		const observer = new ResizeObserver(update);
		for (const ref of [title, controls, pill]) {
			if (ref.current) observer.observe(ref.current);
		}
		window.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [active, stage, title, controls, pill]);
}

/**
 * Transform for one dismiss-morph pair: `translate(t * d) scale(1 + (s - 1) * d)`
 * about the element's top-left, with the page slide compensated so the element
 * stays put while the page leaves. Targets are measured per pair (see
 * measureDismissGeometry); without them this is the identity.
 */
function morphStyle(prefix: string): CSSProperties {
	return {
		transform: `translate(calc(var(${prefix}-tx, 0px) * var(--np-dismiss, 0)), calc(var(${prefix}-ty, 0px) * var(--np-dismiss, 0) - var(--np-slide, 0px))) scale(calc(1 + (var(${prefix}-s, 1) - 1) * var(--np-dismiss, 0)))`,
		transformOrigin: "0 0",
	};
}

/** Track title + artist credit, shared by the mobile stage, compact row and
 * desktop layout. The two lines are wrapped so the dismiss morph can move and
 * scale each one onto its mini-player counterpart independently. */
function TrackHeading({ song, className }: { song: Song; className?: string }) {
	return (
		<div className={cn("max-w-full", className)}>
			<div
				className="np-morph transition-transform duration-300 ease-out"
				data-np-title-line
				style={morphStyle("--np-title")}
			>
				<h1
					className="animate-track-in truncate text-2xl font-bold tracking-tight sm:text-3xl"
					key={`title-${song.id}`}
				>
					<SongTitle artist={song.artist} title={song.title} />
				</h1>
			</div>
			<div
				className="np-morph transition-transform duration-300 ease-out"
				data-np-artist-line
				style={morphStyle("--np-artist")}
			>
				<p
					className="animate-track-in mt-1 truncate text-base text-muted-foreground"
					key={`artist-${song.id}`}
					style={{ animationDelay: "60ms" }}
				>
					<ArtistLinks song={song} />
				</p>
			</div>
		</div>
	);
}

/** Transport controls + lyrics toggle + desktop volume. */
function TransportRow({
	hasNext,
	hasPrevious,
	isPlaying,
	onNext,
	onPrevious,
	onToggle,
	onToggleLyrics,
	showLyrics,
}: {
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
	const rowRef = useRef<HTMLDivElement>(null);
	const [narrow, setNarrow] = useState(false);
	useLayoutEffect(() => {
		const row = rowRef.current;
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
	}, []);

	return (
		<div
			className="grid w-full max-w-md grid-cols-[1fr_auto_1fr] items-center"
			ref={rowRef}
		>
			<div className="col-start-2 row-start-1 flex items-center gap-4">
				<button
					aria-label="Previous"
					className="np-morph grid size-11 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 active:origin-center! disabled:pointer-events-none disabled:opacity-25"
					data-np-prev
					disabled={!hasPrevious}
					onClick={onPrevious}
					style={morphStyle("--np-prev")}
					type="button"
				>
					<SkipBack className="size-5.5 fill-current" />
				</button>
				<button
					aria-label={isPlaying ? "Pause" : "Play"}
					className="np-morph grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_24px_-6px_color-mix(in_oklab,var(--primary)_65%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-90 active:origin-center!"
					data-np-play
					onClick={onToggle}
					style={morphStyle("--np-play")}
					type="button"
				>
					{isPlaying ? (
						<Pause className="size-6 fill-current" />
					) : (
						<Play className="size-6 -translate-x-[4.1667%] fill-current" />
					)}
				</button>
				<button
					aria-label="Next"
					className="np-morph grid size-11 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 active:origin-center! disabled:pointer-events-none disabled:opacity-25"
					data-np-next
					disabled={!hasNext}
					onClick={onNext}
					style={morphStyle("--np-next")}
					type="button"
				>
					<SkipForward className="size-5.5 fill-current" />
				</button>
			</div>
			{/* Lyrics toggle — mobile layout only, anchored to the row's left
			    edge so the transport stays centered. It shrinks out through
			    the left edge (motion, no fade) while the player minimizes so
			    it never lands on the mini player's controls. */}
			<button
				aria-label="Toggle lyrics"
				className={cn(
					"np-morph col-start-1 row-start-1 grid size-11 place-items-center justify-self-start rounded-full transition-colors duration-200 md:hidden",
					showLyrics
						? "bg-primary/15 text-primary"
						: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
				)}
				data-np-lyrics
				onClick={onToggleLyrics}
				style={{
					transform:
						"translateX(calc(var(--np-dismiss, 0) * -70px)) scale(max(0, 1 - var(--np-dismiss, 0) * 2.2))",
				}}
				title="Lyrics"
				type="button"
			>
				<MicVocal className="size-5" />
			</button>
			{/* Volume — expands leftward on hover, anchored to the row's right
			    edge. Its own grid track keeps the slider from ever clipping
			    the transport; when the row is too narrow for that, it pops up
			    vertically over a backdrop instead. Hidden on touch devices,
			    where the hardware volume keys apply, but shown on narrow
			    desktop windows too. */}
			<VolumeControl
				className="col-start-3 row-start-1 justify-self-end pointer-coarse:hidden"
				reverse
				vertical={narrow}
			/>
		</div>
	);
}

/**
 * Seek bar + timecodes. Isolated so the several-times-a-second timeupdate
 * only re-renders this strip, not the backdrop, artwork and up-next rows.
 */
function NowPlayingSeek({
	songId,
	videoElementRef,
	knownDuration,
}: {
	songId: string;
	videoElementRef: VideoRef;
	knownDuration?: number;
}) {
	const { currentTime, duration } = useMediaTime(
		videoElementRef,
		songId,
		knownDuration,
	);
	const handleSeek = (percent: number) => {
		const videoEl = videoElementRef?.current;
		if (videoEl && duration > 0) {
			videoEl.currentTime = percent * duration;
		}
	};
	return (
		<>
			<div
				className="np-morph transition-transform duration-300 ease-out"
				data-np-seek-bar
				style={{
					// Horizontal-only stretch onto the mini strip (see
					// measureDismissGeometry): the track keeps its thickness.
					transform:
						"translate(calc(var(--np-seek-tx, 0px) * var(--np-dismiss, 0)), calc(var(--np-seek-ty, 0px) * var(--np-dismiss, 0) - var(--np-slide, 0px))) scaleX(calc(1 + (var(--np-seek-sx, 1) - 1) * var(--np-dismiss, 0)))",
					transformOrigin: "0 0",
				}}
			>
				<ProgressBar
					onSeek={handleSeek}
					progress={duration > 0 ? currentTime / duration : 0}
				/>
			</div>
			<div
				className="np-morph mt-0.5 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums transition-transform duration-300 ease-out"
				data-np-seek-times
				style={{
					transform: "scale(max(0, 1 - var(--np-dismiss, 0) * 2.5))",
				}}
			>
				<span>{formatTime(currentTime)}</span>
				<span>{formatDuration(duration)}</span>
			</div>
		</>
	);
}

/** Lyrics subscribe to the clock themselves so the fullscreen tree stays put. */
function NowPlayingLyrics({
	song,
	videoElementRef,
	knownDuration,
}: {
	song: Song;
	videoElementRef: VideoRef;
	knownDuration?: number;
}) {
	const { currentTime, duration } = useMediaTime(
		videoElementRef,
		song.id,
		knownDuration,
	);
	const onSeekTime = useCallback(
		(seconds: number) => {
			const videoEl = videoElementRef?.current;
			if (videoEl) videoEl.currentTime = seconds;
		},
		[videoElementRef],
	);
	return (
		<LyricsPanel
			artist={song.artist}
			className="mx-auto w-full max-w-xl"
			currentTime={currentTime}
			duration={duration}
			onSeekTime={onSeekTime}
			songId={song.id}
			title={song.title}
		/>
	);
}

function QueueRow({
	song,
	onPlay,
	queueIndex,
}: {
	song: Song;
	onPlay: () => void;
	/** Queue position; omit for autoplay suggestions. */
	queueIndex?: number;
}) {
	return (
		<SongContextMenu queueIndex={queueIndex} song={song}>
			<button
				className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-card/70 p-1.5 text-left shadow-[0_2px_12px_-4px_oklch(0_0_0/0.4)] backdrop-blur-sm transition-colors duration-200 hover:border-primary/40"
				onClick={onPlay}
				type="button"
			>
				{song.thumbnail ? (
					<img
						alt={song.title}
						className="size-9 shrink-0 rounded-md object-cover"
						loading="lazy"
						src={proxiedImageUrl(song.thumbnail)}
					/>
				) : (
					<div className="size-9 shrink-0 rounded-md bg-muted" />
				)}
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm font-medium">
						<SongTitle artist={song.artist} title={song.title} />
					</p>
					<p className="truncate text-xs text-muted-foreground">
						<ArtistLinks song={song} />
					</p>
				</div>
				{song.duration && (
					<span className="pr-1 font-mono text-[10px] text-muted-foreground/70">
						{song.duration}
					</span>
				)}
			</button>
		</SongContextMenu>
	);
}
