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
import { memo, type RefObject, useCallback, useRef, useState } from "react";
import { ArtistLinks } from "@/components/artist-link";
import { LyricsPanel } from "@/components/lyrics";
import { SongContextMenu } from "@/components/song-menu";
import { SongTitle } from "@/components/song-title";
import { VolumeControl } from "@/components/volume-control";
import { ProgressBar } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useMediaTime } from "@/lib/hooks";
import { useQueueDragGesture } from "@/lib/queue-drag";
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

	// Swipe up anywhere below the progress bar reveals the queue sheet,
	// which follows the finger and snaps open on release. Touches starting
	// on the artwork, title or seek bar itself are ignored.
	const seekRef = useRef<HTMLDivElement>(null);
	const swipeHandlers = useQueueDragGesture((clientY) => {
		const seekBottom =
			seekRef.current?.getBoundingClientRect().bottom ??
			Number.NEGATIVE_INFINITY;
		return clientY >= seekBottom;
	});

	if (!currentSong) return null;

	return (
		<div
			className="relative flex h-full flex-col overflow-hidden bg-background"
			{...swipeHandlers}
		>
			{/* Blurred cover as the backdrop, re-fading on track change */}
			{currentSong.thumbnail && (
				<div
					aria-hidden
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

			{/* Top-right actions: queue + close. The queue button stays visible
			    on mobile — bottom-edge swipes belong to Android's gesture
			    navigation, so the artwork swipe alone is not reliable. */}
			<div className="absolute top-12 right-6 z-20 max-md:top-[max(2.75rem,var(--safe-area-top))] max-md:right-4 flex items-center gap-2">
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
						"flex min-h-0 flex-col max-md:pt-10 md:order-1 md:h-auto md:min-h-0",
						showLyrics
							? "order-1 max-md:h-auto max-md:flex-1"
							: "order-2 h-36 shrink-0 max-md:hidden",
					)}
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
					<div className="mx-auto mt-4 w-full max-w-xl shrink-0 max-lg:hidden">
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

				{/* Artwork + controls. On mobile the controls stay pinned to the
			    bottom: the artwork block flexes into the space above them. */}
				<section
					className={cn(
						"order-1 flex min-h-0 flex-1 flex-col items-center gap-4 max-md:overflow-hidden md:order-2 md:justify-center md:gap-6",
						showLyrics && "max-md:flex-none",
					)}
				>
					{/* Artwork + title. Compact row in mobile lyrics mode, stacked
					    and centered otherwise. */}
					<div
						className={cn(
							"flex w-full items-center gap-4 max-md:flex-1",
							showLyrics
								? "max-md:justify-start"
								: "max-md:flex-col max-md:justify-center",
							"md:flex-col md:gap-6",
						)}
					>
						{/* Artwork */}
						<div
							className={cn(
								"group relative touch-none select-none",
								showLyrics && "max-md:w-16 max-md:shrink-0",
							)}
						>
							<div
								aria-hidden
								className={cn(
									"absolute -inset-7 rounded-[2.5rem] bg-primary/20 blur-3xl",
									showLyrics && "max-md:hidden",
								)}
							/>
							{currentSong.thumbnail ? (
								<img
									alt={currentSong.title}
									className={cn(
										"animate-track-in relative aspect-square rounded-2xl border border-foreground/10 object-cover shadow-[0_24px_70px_-20px_oklch(0_0_0/0.7)] md:w-[min(40vh,320px)]",
										showLyrics
											? "max-md:w-16 max-md:rounded-xl"
											: "max-md:w-[min(34vh,280px)]",
									)}
									draggable={false}
									key={`art-${currentSong.id}`}
									src={proxiedImageUrl(currentSong.thumbnail)}
								/>
							) : (
								<div
									className={cn(
										"relative grid aspect-square place-items-center rounded-2xl border border-foreground/10 bg-card md:w-[min(40vh,320px)]",
										showLyrics
											? "max-md:w-16 max-md:rounded-xl"
											: "max-md:w-[min(34vh,280px)]",
									)}
								>
									<Music2 className="size-14 text-muted-foreground" />
								</div>
							)}
						</div>

						{/* Title + artist */}
						<div
							className={cn(
								"max-w-full text-center",
								showLyrics && "min-w-0 flex-1 max-md:text-left",
							)}
						>
							<h1
								className="animate-track-in truncate text-2xl font-bold tracking-tight sm:text-3xl"
								key={`title-${currentSong.id}`}
							>
								<SongTitle
									artist={currentSong.artist}
									title={currentSong.title}
								/>
							</h1>
							<p
								className="animate-track-in mt-1 truncate text-base text-muted-foreground"
								key={`artist-${currentSong.id}`}
								style={{ animationDelay: "60ms" }}
							>
								<ArtistLinks song={currentSong} />
							</p>
						</div>
					</div>

					{/* Seek + timecodes — swipes starting here or above are ignored */}
					<div className="w-full max-w-md" ref={seekRef}>
						<NowPlayingSeek
							knownDuration={knownDuration}
							songId={currentSong.id}
							videoElementRef={videoElementRef}
						/>
					</div>

					{/* Transport + volume */}
					<div className="relative flex w-full max-w-md items-center justify-center">
						<div className="flex items-center gap-4">
							<button
								aria-label="Previous"
								className="grid size-11 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
								disabled={!hasPrevious}
								onClick={previous}
								type="button"
							>
								<SkipBack className="size-5.5 fill-current" />
							</button>
							<button
								aria-label={isPlaying ? "Pause" : "Play"}
								className="grid size-14 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_24px_-6px_color-mix(in_oklab,var(--primary)_65%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-90"
								onClick={toggle}
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
								className="grid size-11 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
								disabled={!hasNext}
								onClick={next}
								type="button"
							>
								<SkipForward className="size-5.5 fill-current" />
							</button>
						</div>
						{/* Lyrics toggle — mobile only, mirrors the desktop volume's
					    anchored position so the transport stays centered */}
						<button
							aria-label="Toggle lyrics"
							className={cn(
								"absolute top-1/2 left-0 grid size-11 -translate-y-1/2 place-items-center rounded-full transition-colors duration-200 md:hidden",
								showLyrics
									? "bg-primary/15 text-primary"
									: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
							)}
							onClick={() => setShowLyrics((value) => !value)}
							title="Lyrics"
							type="button"
						>
							<MicVocal className="size-5" />
						</button>
						{/* Volume — expands leftward on hover, anchored to the right edge.
					    Hidden on touch devices: the hardware volume keys apply. */}
						<VolumeControl
							className="absolute top-1/2 right-0 -translate-y-1/2 max-md:hidden"
							reverse
						/>
					</div>

					{/* Queue affordance (mobile): tapping opens the sheet, swiping
					    up anywhere below the progress bar drags it in. */}
					<button
						aria-label="Open queue"
						className="mx-auto flex items-center gap-1.5 rounded-full bg-foreground/6 px-3 py-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-foreground/10 hover:text-foreground active:scale-95 md:hidden"
						onClick={() => onToggleQueue()}
						type="button"
					>
						<ChevronsUp className="size-3.5" />
						Queue
					</button>
				</section>
			</main>
		</div>
	);
});

type VideoRef = RefObject<HTMLVideoElement | null> | null;

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
			<ProgressBar
				onSeek={handleSeek}
				progress={duration > 0 ? currentTime / duration : 0}
			/>
			<div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
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
