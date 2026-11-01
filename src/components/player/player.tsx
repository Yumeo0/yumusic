import {
	ChevronUp,
	ListMusic,
	Pause,
	Play,
	SkipBack,
	SkipForward,
} from "lucide-react";
import { type RefObject, useRef } from "react";
import { RatingButtons } from "@/components/player/rating-buttons";
import { RepeatButton } from "@/components/player/repeat-button";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useRoomRole } from "@/lib/listen-together/room";
import { useNowPlayingSwipe } from "@/lib/motion/now-playing-motion";
import {
	toggleNowPlaying,
	toggleQueue,
	useQueueOpen,
} from "@/lib/player/player-ui";
import { useMediaTime } from "@/lib/utils/hooks";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn, formatDuration, formatTime } from "@/lib/utils/utils";
import { ArtistLinks } from "../song/artist-link";
import { DeviceButton } from "./device-picker";
import { VolumeControl } from "./volume-control";
import { ProgressBar } from "./waveform";

export function Player() {
	const {
		currentSong,
		currentAlbum,
		next,
		previous,
		hasNext,
		hasPrevious,
		videoElementRef,
		duration: knownDuration,
	} = usePlayer();
	const { isPlaying, toggle } = usePlayerControls();
	const isQueueOpen = useQueueOpen();
	// Swipe up on the mini player expands the fullscreen player progressively.
	// The bar sits above Android's bottom gesture zone, so the touch
	// reliably reaches the webview — unlike swipes starting at the very
	// bottom edge, which the system claims for the Home gesture. Only
	// touches on the main row count; the progress strip above is seeking.
	const swipeRowRef = useRef<HTMLDivElement>(null);
	const swipeHandlers = useNowPlayingSwipe(true, (event) => {
		const touch = event.touches[0];
		const rowTop = swipeRowRef.current?.getBoundingClientRect().top;
		return (
			touch !== undefined && rowTop !== undefined && touch.clientY >= rowTop
		);
	});

	if (!currentSong) return null;

	return (
		<footer
			className="fixed inset-x-0 bottom-0 z-46 max-md:bottom-[calc(3.75rem+var(--safe-area-bottom))] max-md:pb-1.5 cursor-default border-t border-foreground/8 bg-background/85 backdrop-blur-xl transition-colors duration-200 hover:bg-background/95"
			data-mini-player
			onClick={toggleNowPlaying}
			{...swipeHandlers}
		>
			{/* Progress — seeking must not trigger the fullscreen open */}
			<div className="px-4 pt-1.5 sm:px-5" onClick={(e) => e.stopPropagation()}>
				<div data-mini-progress>
					<MiniProgress
						knownDuration={knownDuration}
						songId={currentSong.id}
						videoElementRef={videoElementRef}
					/>
				</div>
			</div>

			{/* Track identity — click to open fullscreen. The row owns the
			    `group` so the hover feedback (title highlight, artwork chevron)
			    also fires on the empty parts of the bar. Controls are marked
			    `.player-ctl`, and the `group-has-…` classes below cancel the
			    feedback while one of them is hovered — matching the fact that
			    clicking a control doesn't open the fullscreen. */}
			<div
				className="group grid h-17 touch-none grid-cols-[1fr_auto_1fr] max-md:grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 sm:px-5"
				ref={swipeRowRef}
			>
				<SongContextMenu song={currentSong}>
					<button
						className="flex min-w-0 items-center gap-3 text-left"
						onClick={(e) => {
							e.stopPropagation();
							toggleNowPlaying();
						}}
						title="Open Now Playing"
						type="button"
					>
						<div className="relative shrink-0" data-mini-thumb>
							{currentSong.thumbnail ? (
								<img
									alt={currentSong.title}
									className="size-11 rounded-md border border-foreground/10 object-cover"
									key={currentSong.id}
									src={proxiedImageUrl(currentSong.thumbnail, 96)}
								/>
							) : (
								<div className="size-11 rounded-md bg-muted" />
							)}
							<span className="absolute inset-0 grid place-items-center rounded-md bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-has-[.player-ctl:hover]:opacity-0">
								<ChevronUp className="size-4 text-white" />
							</span>
						</div>
						<div className="min-w-0" data-mini-title>
							<h3
								className="animate-track-in flex items-center gap-1.5 text-sm font-semibold leading-tight transition-colors group-hover:text-primary group-has-[.player-ctl:hover]:text-foreground"
								key={`t-${currentSong.id}`}
							>
								<span className="min-w-0 truncate" data-mini-title-line>
									<SongTitle
										artist={currentSong.artist}
										keepTitle={currentSong.upload}
										title={currentSong.title}
									/>
								</span>
								<DownloadedBadge data-mini-download songId={currentSong.id} />
							</h3>
							<p
								className="animate-track-in truncate text-xs text-muted-foreground"
								key={`a-${currentSong.id}`}
								style={{ animationDelay: "60ms" }}
							>
								<span data-mini-artist>
									<ArtistLinks song={currentSong} />
								</span>
								{currentAlbum && (
									<span title={`Album or single: ${currentAlbum.name}`}>
										<span
											aria-hidden
											className="mx-1 inline-block"
											data-player-morph-extra
										>
											{" "}
											·{" "}
										</span>
										<span data-mini-album>{currentAlbum.name}</span>
									</span>
								)}
							</p>
						</div>
					</button>
				</SongContextMenu>

				{/* Transport */}
				<div className="flex items-center gap-1 sm:gap-2" data-mini-controls>
					<button
						aria-label="Previous"
						className="player-ctl grid size-9 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
						data-mini-prev
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
							"player-ctl grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_16px_-4px_color-mix(in_oklab,var(--primary)_60%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-90",
						)}
						data-mini-play
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
						className="player-ctl grid size-9 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
						data-mini-next
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
					<DeviceButton />
					<div data-mini-repeat>
						<RepeatButton />
					</div>
					<MiniTime
						knownDuration={knownDuration}
						songId={currentSong.id}
						videoElementRef={videoElementRef}
					/>
					{/* Rating clicks must not open the fullscreen. Hidden on
					    narrower windows, where the title needs the room. */}
					<div
						className="player-ctl max-lg:hidden"
						data-mini-ratings
						onClick={(e) => e.stopPropagation()}
					>
						<RatingButtons songId={currentSong.id} />
					</div>
					<button
						aria-label="Toggle queue"
						className={cn(
							"player-ctl grid size-9 place-items-center rounded-full transition-all duration-200 active:scale-90",
							isQueueOpen
								? "bg-primary/12 text-primary"
								: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
						)}
						data-mini-queue
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
					<div
						className="player-ctl"
						data-mini-volume
						onClick={(e) => e.stopPropagation()}
					>
						<VolumeControl vertical />
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
	const { seek } = usePlayer();
	const roomRole = useRoomRole();
	const handleSeek = (percent: number) => {
		const videoEl = videoElementRef?.current;
		if (videoEl && duration > 0) {
			seek(percent * duration);
		}
	};
	return (
		<ProgressBar
			onSeek={roomRole === "guest" ? undefined : handleSeek}
			onSeekCommit={handleSeek}
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
			<span className="text-foreground/80" data-mini-elapsed>
				{formatTime(currentTime)}
			</span>
			<span
				className="mx-1 inline-block text-foreground/25"
				data-player-morph-extra
			>
				/
			</span>
			<span data-mini-duration>{formatDuration(duration)}</span>
		</span>
	);
}
