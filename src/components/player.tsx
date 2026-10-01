import {
	ChevronUp,
	ListMusic,
	Pause,
	Play,
	SkipBack,
	SkipForward,
} from "lucide-react";
import { useRef, type RefObject } from "react";
import { SongTitle } from "@/components/song-title";
import { usePlayer } from "@/contexts/player-context";
import { useMediaTime } from "@/lib/hooks";
import { useQueueDragGesture } from "@/lib/queue-drag";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn, formatDuration, formatTime } from "@/lib/utils";
import { ArtistLinks } from "./artist-link";
import { VolumeControl } from "./volume-control";
import { ProgressBar } from "./waveform";

export function Player() {
	const {
		currentSong,
		isPlaying,
		toggle,
		next,
		previous,
		hasNext,
		hasPrevious,
		toggleNowPlaying,
		toggleQueue,
		isQueueOpen,
		videoElementRef,
		duration: knownDuration,
	} = usePlayer();

	// Swipe up on the mini player reveals the queue sheet progressively.
	// The bar sits above Android's bottom gesture zone, so the touch
	// reliably reaches the webview — unlike swipes starting at the very
	// bottom edge, which the system claims for the Home gesture. Only
	// touches on the main row count; the progress strip above is seeking.
	const swipeRowRef = useRef<HTMLDivElement>(null);
	const swipeHandlers = useQueueDragGesture((clientY) => {
		const rowTop = swipeRowRef.current?.getBoundingClientRect().top;
		return rowTop !== undefined && clientY >= rowTop;
	});

	if (!currentSong) return null;

	return (
		<footer
			className="fixed inset-x-0 bottom-0 z-40 max-md:bottom-[calc(3.25rem+var(--safe-area-bottom))] cursor-pointer border-t border-foreground/8 bg-background/85 backdrop-blur-xl transition-colors duration-200 hover:bg-background/95"
			onClick={toggleNowPlaying}
			{...swipeHandlers}
		>
			{/* Progress — seeking must not trigger the fullscreen open */}
			<div className="px-4 pt-1.5 sm:px-5" onClick={(e) => e.stopPropagation()}>
				<MiniProgress
					knownDuration={knownDuration}
					songId={currentSong.id}
					videoElementRef={videoElementRef}
				/>
			</div>

			<div
				className="grid h-17 grid-cols-[1fr_auto_1fr] max-md:grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 sm:px-5"
				ref={swipeRowRef}
			>
				{/* Track identity — click to open fullscreen */}
				<button
					className="group flex min-w-0 items-center gap-3 text-left"
					onClick={(e) => {
						e.stopPropagation();
						toggleNowPlaying();
					}}
					title="Open Now Playing"
					type="button"
				>
					<div className="relative shrink-0">
						{currentSong.thumbnail ? (
							<img
								alt={currentSong.title}
								className="size-11 rounded-md border border-foreground/10 object-cover"
								key={currentSong.id}
								src={proxiedImageUrl(currentSong.thumbnail)}
							/>
						) : (
							<div className="size-11 rounded-md bg-muted" />
						)}
						<span className="absolute inset-0 grid place-items-center rounded-md bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
							<ChevronUp className="size-4 text-white" />
						</span>
					</div>
					<div className="min-w-0">
						<h3
							className="animate-track-in truncate text-sm font-semibold leading-tight transition-colors group-hover:text-primary"
							key={`t-${currentSong.id}`}
						>
							<SongTitle
								artist={currentSong.artist}
								title={currentSong.title}
							/>
						</h3>
						<p
							className="animate-track-in truncate text-xs text-muted-foreground"
							key={`a-${currentSong.id}`}
							style={{ animationDelay: "60ms" }}
						>
							<ArtistLinks song={currentSong} />
						</p>
					</div>
				</button>

				{/* Transport */}
				<div className="flex items-center gap-1 sm:gap-2">
					<button
						aria-label="Previous"
						className="grid size-9 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
						disabled={!hasPrevious}
						onClick={(e) => {
							e.stopPropagation();
							previous();
						}}
						type="button"
					>
						<SkipBack className="size-4.5 fill-current" />
					</button>
					<button
						aria-label={isPlaying ? "Pause" : "Play"}
						className={cn(
							"grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_16px_-4px_color-mix(in_oklab,var(--primary)_60%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-90",
						)}
						onClick={(e) => {
							e.stopPropagation();
							toggle();
						}}
						type="button"
					>
						{isPlaying ? (
							<Pause className="size-5 fill-current" />
						) : (
							<Play className="size-5 -translate-x-[4.1667%] fill-current" />
						)}
					</button>
					<button
						aria-label="Next"
						className="grid size-9 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
						disabled={!hasNext}
						onClick={(e) => {
							e.stopPropagation();
							next();
						}}
						type="button"
					>
						<SkipForward className="size-4.5 fill-current" />
					</button>
				</div>

				{/* Timecodes + queue + volume (desktop only — phones use the
			    now-playing screen, where volume follows the hardware keys) */}
				<div className="flex items-center justify-end gap-3 max-md:hidden">
					<MiniTime
						knownDuration={knownDuration}
						songId={currentSong.id}
						videoElementRef={videoElementRef}
					/>
					<button
						aria-label="Toggle queue"
						className={cn(
							"grid size-9 place-items-center rounded-full transition-all duration-200 active:scale-90",
							isQueueOpen
								? "bg-primary/12 text-primary"
								: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
						)}
						onClick={(e) => {
							e.stopPropagation();
							toggleQueue();
						}}
						title="Queue"
						type="button"
					>
						<ListMusic className="size-4.5" />
					</button>
					{/* Volume interactions must not open the fullscreen */}
					<div onClick={(e) => e.stopPropagation()}>
						<VolumeControl />
					</div>
				</div>
			</div>
		</footer>
	);
}

type VideoRef = RefObject<HTMLVideoElement | null> | null;

/**
 * Progress strip and timecodes subscribe to the media clock on their own, so
 * the blurred footer doesn't re-render (and re-filter its backdrop) several
 * times a second as playback advances.
 */
function MiniProgress({
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
		<ProgressBar
			onSeek={handleSeek}
			progress={duration > 0 ? currentTime / duration : 0}
		/>
	);
}

function MiniTime({
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
	return (
		<span className="font-mono text-xs text-muted-foreground tabular-nums">
			<span className="text-foreground/80">{formatTime(currentTime)}</span>
			<span className="mx-1 text-foreground/25">/</span>
			{formatDuration(duration)}
		</span>
	);
}
