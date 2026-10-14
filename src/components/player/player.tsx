import {
	ChevronUp,
	ListMusic,
	Pause,
	Play,
	SkipBack,
	SkipForward,
} from "@lucide/solid";
import { type Accessor, Show } from "solid-js";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useNowPlayingSwipe } from "@/lib/motion/now-playing-motion";
import {
	queueOpen,
	toggleNowPlaying,
	toggleQueue,
} from "@/lib/player/player-ui";
import { useMediaTime } from "@/lib/utils/hooks";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn, formatDuration, formatTime } from "@/lib/utils/utils";
import { ArtistLinks } from "../song/artist-link";
import { VolumeControl } from "./volume-control";
import { ProgressBar } from "./waveform";

export function Player() {
	const player = usePlayer();
	const controls = usePlayerControls();
	let swipeRow!: HTMLDivElement;
	// Swipe up on the mini player expands the fullscreen player progressively.
	// The bar sits above Android's bottom gesture zone, so the touch
	// reliably reaches the webview — unlike swipes starting at the very
	// bottom edge, which the system claims for the Home gesture. Only
	// touches on the main row count; the progress strip above is seeking.
	const swipe = useNowPlayingSwipe(true, (event) => {
		const touch = event.touches[0];
		const rowTop = swipeRow?.getBoundingClientRect().top;
		return (
			touch !== undefined && rowTop !== undefined && touch.clientY >= rowTop
		);
	});

	return (
		<Show when={player.currentSong()}>
			{(song) => (
				<footer
					class="fixed inset-x-0 bottom-0 z-40 max-md:bottom-[calc(3.75rem+var(--safe-area-bottom))] max-md:pb-1.5 cursor-default border-t border-foreground/8 bg-background/85 backdrop-blur-xl transition-colors duration-200 hover:bg-background/95"
					data-mini-player
					onClick={toggleNowPlaying}
					onTouchCancel={swipe.onTouchCancel}
					onTouchEnd={swipe.onTouchEnd}
					onTouchMove={swipe.onTouchMove}
					ref={(el) => {
						swipe.attach(el);
					}}
				>
					{/* Progress — seeking must not trigger the fullscreen open */}
					<div class="px-4 pt-1.5 sm:px-5" onClick={(e) => e.stopPropagation()}>
						<div data-mini-progress>
							<MiniProgress
								knownDuration={player.duration()}
								songId={song().id}
								videoElement={player.videoElement}
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
						class="group grid h-17 touch-none grid-cols-[1fr_auto_1fr] max-md:grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 sm:px-5"
						ref={swipeRow}
					>
						<SongContextMenu song={song()}>
							<button
								class="flex min-w-0 items-center gap-3 text-left"
								onClick={(e) => {
									e.stopPropagation();
									toggleNowPlaying();
								}}
								title="Open Now Playing"
								type="button"
							>
								<div class="relative shrink-0" data-mini-thumb>
									<Show
										fallback={<div class="size-11 rounded-md bg-muted" />}
										when={song().thumbnail}
									>
										{(thumbnail) => (
											<img
												alt={song().title}
												class="size-11 rounded-md border border-foreground/10 object-cover"
												src={proxiedImageUrl(thumbnail())}
											/>
										)}
									</Show>
									<span class="absolute inset-0 grid place-items-center rounded-md bg-black/50 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-has-[.player-ctl:hover]:opacity-0">
										<ChevronUp class="size-4 text-white" />
									</span>
								</div>
								<div class="min-w-0" data-mini-title>
									{/* Keyed per song so the entrance animation replays. */}
									<Show keyed when={song().id}>
										{(songId) => (
											<h3
												class="animate-track-in flex items-center gap-1.5 text-sm font-semibold leading-tight transition-colors group-hover:text-primary group-has-[.player-ctl:hover]:text-foreground"
												data-mini-title-line
											>
												<span class="min-w-0 truncate">
													<SongTitle
														artist={song().artist}
														keepTitle={song().upload}
														title={song().title}
													/>
												</span>
												<DownloadedBadge songId={songId} />
											</h3>
										)}
									</Show>
									<Show keyed when={song().id}>
										{(_songId) => (
											<p
												class="animate-track-in truncate text-xs text-muted-foreground"
												data-mini-artist
												style={{ "animation-delay": "60ms" }}
											>
												<ArtistLinks song={song()} />
											</p>
										)}
									</Show>
								</div>
							</button>
						</SongContextMenu>

						{/* Transport */}
						<div class="flex items-center gap-1 sm:gap-2" data-mini-controls>
							<button
								aria-label="Previous"
								class="player-ctl grid size-9 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
								data-mini-prev
								disabled={!player.hasPrevious()}
								onClick={(e) => {
									e.stopPropagation();
									void player.previous();
								}}
								type="button"
							>
								<SkipBack class="size-4.5 fill-current" />
							</button>
							<button
								aria-label={controls.isPlaying() ? "Pause" : "Play"}
								class={cn(
									"player-ctl grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_16px_-4px_color-mix(in_oklab,var(--primary)_60%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-90",
								)}
								data-mini-play
								onClick={(e) => {
									e.stopPropagation();
									controls.toggle();
								}}
								type="button"
							>
								<Show
									fallback={
										<Play class="size-5 -translate-x-[4.1667%] fill-current" />
									}
									when={controls.isPlaying()}
								>
									<Pause class="size-5 fill-current" />
								</Show>
							</button>
							<button
								aria-label="Next"
								class="player-ctl grid size-9 place-items-center rounded-full text-foreground/80 transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-25"
								data-mini-next
								disabled={!player.hasNext()}
								onClick={(e) => {
									e.stopPropagation();
									void player.next();
								}}
								type="button"
							>
								<SkipForward class="size-4.5 fill-current" />
							</button>
						</div>

						{/* Timecodes + queue + volume (desktop only — phones use the
					    now-playing screen, where volume follows the hardware keys) */}
						<div class="flex items-center justify-end gap-3 max-md:hidden">
							<MiniTime
								knownDuration={player.duration()}
								songId={song().id}
								videoElement={player.videoElement}
							/>
							<button
								aria-label="Toggle queue"
								class={cn(
									"player-ctl grid size-9 place-items-center rounded-full transition-all duration-200 active:scale-90",
									queueOpen()
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
								<ListMusic class="size-4.5" />
							</button>
							{/* Volume interactions must not open the fullscreen */}
							<div class="player-ctl" onClick={(e) => e.stopPropagation()}>
								<VolumeControl />
							</div>
						</div>
					</div>
				</footer>
			)}
		</Show>
	);
}

/**
 * Progress strip and timecodes subscribe to the media clock on their own, so
 * the blurred footer doesn't re-render (and re-filter its backdrop) several
 * times a second as playback advances.
 */
function MiniProgress(props: {
	songId: string;
	videoElement: Accessor<HTMLVideoElement | null>;
	knownDuration: number;
}) {
	const { currentTime, duration } = useMediaTime(
		() => props.videoElement(),
		() => props.songId,
		() => props.knownDuration,
	);
	const handleSeek = (percent: number) => {
		const videoEl = props.videoElement();
		const total = duration();
		if (videoEl && total > 0) {
			videoEl.currentTime = percent * total;
		}
	};
	return (
		<ProgressBar
			onSeek={handleSeek}
			progress={duration() > 0 ? currentTime() / duration() : 0}
		/>
	);
}

function MiniTime(props: {
	songId: string;
	videoElement: Accessor<HTMLVideoElement | null>;
	knownDuration: number;
}) {
	const { currentTime, duration } = useMediaTime(
		() => props.videoElement(),
		() => props.songId,
		() => props.knownDuration,
	);
	return (
		<span class="font-mono text-xs text-muted-foreground tabular-nums">
			<span class="text-foreground/80">{formatTime(currentTime())}</span>
			<span class="mx-1 text-foreground/25">/</span>
			{formatDuration(duration())}
		</span>
	);
}
