import {
	ChevronDown,
	ListMusic,
	Music2,
	Pause,
	Play,
	SkipBack,
	SkipForward,
} from "lucide-react";
import { ArtistLinks } from "@/components/artist-link";
import { LyricsPanel } from "@/components/lyrics";
import { SongTitle } from "@/components/song-title";
import { VolumeControl } from "@/components/volume-control";
import { ProgressBar } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { useMediaTime } from "@/lib/hooks";
import { cn, formatTime } from "@/lib/utils";

interface NowPlayingPageProps {
	onClose: () => void;
}

/**
 * Fullscreen "Now Playing" experience.
 * Left: lyrics. Right: artwork, transport, seek. Tinted with the accent
 * color derived from the current song's thumbnail.
 */
export function NowPlayingPage({ onClose }: NowPlayingPageProps) {
	const {
		currentSong,
		isPlaying,
		toggle,
		queue,
		currentIndex,
		next,
		previous,
		hasNext,
		hasPrevious,
		play,
		isQueueOpen,
		toggleQueue,
		videoElementRef,
	} = usePlayer();

	const { currentTime, duration } = useMediaTime(
		videoElementRef,
		currentSong?.id,
	);
	const progress = duration > 0 ? currentTime / duration : 0;

	if (!currentSong) return null;

	const handleSeek = (percent: number) => {
		const videoEl = videoElementRef?.current;
		if (videoEl && duration > 0) {
			videoEl.currentTime = percent * duration;
		}
	};

	return (
		<div className="relative flex h-screen flex-col overflow-hidden bg-background">
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
						src={currentSong.thumbnail}
					/>
					<div className="absolute inset-0 bg-background/60" />
				</div>
			)}

			{/* Top-right actions: queue + close */}
			<div className="absolute top-5 right-6 z-20 flex items-center gap-2">
				<button
					aria-label="Toggle queue"
					className={cn(
						"grid size-9 place-items-center rounded-full transition-colors duration-200",
						isQueueOpen
							? "bg-primary/15 text-primary"
							: "text-muted-foreground hover:bg-foreground/8 hover:text-foreground",
					)}
					onClick={toggleQueue}
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

			{/* Body: lyrics left · art + controls right */}
			<main className="relative z-10 grid min-h-0 flex-1 gap-10 px-6 pt-14 pb-8 sm:px-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14">
				{/* Lyrics */}
				<section className="flex min-h-0 flex-col">
					<LyricsPanel
						artist={currentSong.artist}
						className="mx-auto w-full max-w-xl"
						currentTime={currentTime}
						duration={duration}
						onSeekTime={(seconds) => {
							const videoEl = videoElementRef?.current;
							if (videoEl) {
								videoEl.currentTime = seconds;
							}
						}}
						songId={currentSong.id}
						title={currentSong.title}
					/>
				</section>

				{/* Artwork + controls */}
				<section className="flex min-h-0 flex-col items-center justify-center gap-6">
					{/* Artwork */}
					<div className="group relative">
						<div
							aria-hidden
							className="absolute -inset-7 rounded-[2.5rem] bg-primary/20 blur-3xl"
						/>
						{currentSong.thumbnail ? (
							<img
								alt={currentSong.title}
								className="animate-track-in relative aspect-square w-[min(40vh,320px)] rounded-2xl border border-foreground/10 object-cover shadow-[0_24px_70px_-20px_oklch(0_0_0/0.7)]"
								key={`art-${currentSong.id}`}
								src={currentSong.thumbnail}
							/>
						) : (
							<div className="relative grid aspect-square w-[min(40vh,320px)] place-items-center rounded-2xl border border-foreground/10 bg-card">
								<Music2 className="size-14 text-muted-foreground" />
							</div>
						)}
					</div>

					{/* Title + artist */}
					<div className="max-w-full text-center">
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
							className="animate-track-in mt-1 text-base text-muted-foreground"
							key={`artist-${currentSong.id}`}
							style={{ animationDelay: "60ms" }}
						>
							<ArtistLinks song={currentSong} />
						</p>
					</div>

					{/* Seek + timecodes */}
					<div className="w-full max-w-md">
						<ProgressBar onSeek={handleSeek} progress={progress} />
						<div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
							<span>{formatTime(currentTime)}</span>
							<span>{formatTime(duration)}</span>
						</div>
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
									<Play className="size-6 translate-x-[1px] fill-current" />
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
						{/* Volume — expands leftward on hover, anchored to the right edge */}
						<VolumeControl
							className="absolute top-1/2 right-0 -translate-y-1/2"
							reverse
						/>
					</div>

					{/* Up next — the next card plus ~3 more tucked underneath it
					    (whole cards, only their top edges peeking). On hover they
					    slide down into the reserved space, so nothing else moves. */}
					<div className="w-full max-w-md">
						<div className="mb-1.5 flex items-baseline justify-between">
							<p className="text-xs font-medium text-muted-foreground">
								Up next
							</p>
							{queue.length > currentIndex + 1 && (
								<p className="text-[11px] text-muted-foreground/60">
									{queue.length - currentIndex - 1} in queue
								</p>
							)}
						</div>
						{queue.length > currentIndex + 1 ? (
							<div className="group/upn">
								<div className="relative z-20">
									<QueueRow
										onPlay={() => play(queue[currentIndex + 1])}
										song={queue[currentIndex + 1]}
									/>
								</div>
								<div className="h-[176px] overflow-hidden">
									{queue
										.slice(currentIndex + 2, currentIndex + 5)
										.map((song, k) => (
											<div
												className={cn(
													"relative -mt-[46px] origin-top scale-[0.97] transition-all duration-300 ease-out group-hover/upn:mt-1.5 group-hover/upn:scale-100",
												)}
												// biome-ignore lint/suspicious/noArrayIndexKey: queue may contain duplicate video ids
												key={`queue-${song.id}-${currentIndex + 2 + k}`}
												style={{
													transitionDelay: `${k * 60}ms`,
													zIndex: 10 - k,
												}}
											>
												<QueueRow onPlay={() => play(song)} song={song} />
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
			</main>
		</div>
	);
}

function QueueRow({ song, onPlay }: { song: Song; onPlay: () => void }) {
	return (
		<button
			className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-card p-1.5 text-left shadow-[0_2px_12px_-4px_oklch(0_0_0/0.4)] transition-colors duration-200 hover:border-primary/40"
			onClick={onPlay}
			type="button"
		>
			{song.thumbnail ? (
				<img
					alt={song.title}
					className="size-9 shrink-0 rounded-md object-cover"
					loading="lazy"
					src={song.thumbnail}
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
	);
}
