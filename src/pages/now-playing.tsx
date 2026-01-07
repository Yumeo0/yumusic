import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePlayer } from "@/contexts/player-context";

interface NowPlayingPageProps {
	onClose: () => void;
}

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
		videoElementRef,
	} = usePlayer();

	if (!currentSong) {
		return null;
	}

	const handleQueueItemClick = (index: number) => {
		const clickedSong = queue[index];
		play(clickedSong);
	};

	return (
		<div className="h-screen bg-background flex">
			{/* Left side - Video player and controls - Clickable to close */}
			<button
				className="flex-1 flex flex-col items-center justify-center p-8 gap-8 cursor-pointer"
				onClick={onClose}
				type="button"
			>
				{/* Video Player - Thumbnail display (actual video element is hidden in Player component) */}
				<div className="w-full max-w-md aspect-square bg-black rounded-lg shadow-2xl overflow-hidden relative">
					{/* Video element */}
					<video
						className="absolute inset-0 w-full h-full object-cover"
						onEnded={() => {
							if (hasNext) {
								next();
							}
						}}
						ref={videoElementRef}
					/>
					{/* Thumbnail fallback */}
					<img
						alt={currentSong.title}
						className="absolute inset-0 w-full h-full object-cover -z-10"
						src={currentSong.thumbnail}
					/>
				</div>

				{/* Song info */}
				<div className="text-center max-w-md w-full">
					<h1 className="text-3xl font-bold mb-2">{currentSong.title}</h1>
					<p className="text-xl text-muted-foreground">{currentSong.artist}</p>
				</div>

				{/* Controls */}
				<div className="flex items-center gap-6">
					<Button
						className="w-12 h-12"
						disabled={!hasPrevious}
						onClick={(e) => {
							e.stopPropagation();
							previous();
						}}
						size="icon"
						variant="ghost"
					>
						<SkipBack className="w-6 h-6" />
					</Button>
					<Button
						className="rounded-full w-16 h-16"
						onClick={(e) => {
							e.stopPropagation();
							toggle();
						}}
						size="icon"
					>
						{isPlaying ? (
							<Pause className="w-8 h-8" />
						) : (
							<Play className="w-8 h-8" />
						)}
					</Button>
					<Button
						className="w-12 h-12"
						disabled={!hasNext}
						onClick={(e) => {
							e.stopPropagation();
							next();
						}}
						size="icon"
						variant="ghost"
					>
						<SkipForward className="w-6 h-6" />
					</Button>
				</div>
			</button>

			{/* Right side - Queue */}
			<div className="w-96 border-l bg-muted/10 flex flex-col h-screen">
				<div className="p-4 border-b flex-shrink-0">
					<h2 className="text-lg font-semibold">Up Next</h2>
					<p className="text-sm text-muted-foreground">
						{queue.length} {queue.length === 1 ? "song" : "songs"}
					</p>
				</div>
				<ScrollArea className="flex-1 min-h-0">
					<div className="p-4 space-y-2">
						{queue.length === 0 ? (
							<p className="text-muted-foreground text-sm text-center py-8">
								No songs in queue
							</p>
						) : (
							queue.map((song, index) => {
								const isCurrentSong = index === currentIndex;
								return (
									<button
										className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors text-left group ${
											isCurrentSong
												? "bg-primary/20 border-2 border-primary"
												: "hover:bg-muted border-2 border-transparent"
										}`}
										key={`${song.id}-${index}`}
										onClick={() => handleQueueItemClick(index)}
										type="button"
									>
										<img
											alt={song.title}
											className="w-12 h-12 rounded object-cover"
											src={song.thumbnail}
										/>
										<div className="flex-1 min-w-0">
											<h3
												className={`font-medium line-clamp-1 transition-colors ${
													isCurrentSong
														? "text-primary"
														: "group-hover:text-primary"
												}`}
											>
												{song.title}
											</h3>
											<p className="text-sm text-muted-foreground line-clamp-1">
												{song.artist}
											</p>
										</div>
										{song.duration && (
											<span className="text-sm text-muted-foreground">
												{song.duration}
											</span>
										)}
									</button>
								);
							})
						)}
					</div>
				</ScrollArea>
			</div>
		</div>
	);
}
