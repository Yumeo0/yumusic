import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { usePlayer } from "@/contexts/player-context";

export function Player() {
	const { currentSong, isPlaying, toggle, streamUrl } = usePlayer();
	const audioRef = useRef<HTMLAudioElement>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
	useEffect(() => {
		if (audioRef.current) {
			if (isPlaying) {
				audioRef.current
					.play()
					.catch((e) => console.error("Playback failed", e));
			} else {
				audioRef.current.pause();
			}
		}
	}, [isPlaying, streamUrl]);

	if (!currentSong) return null;

	return (
		<div className="fixed bottom-0 left-0 right-0 p-4 bg-background border-t z-50">
			<div className="container mx-auto flex items-center justify-between">
				<div className="flex items-center gap-4 w-1/3">
					{currentSong.thumbnail && (
						<img
							alt={currentSong.title}
							className="w-12 h-12 rounded object-cover"
							src={currentSong.thumbnail}
						/>
					)}
					<div>
						<h3 className="font-medium line-clamp-1">{currentSong.title}</h3>
						<p className="text-sm text-muted-foreground line-clamp-1">
							{currentSong.artist}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-4">
					<Button size="icon" variant="ghost">
						<SkipBack className="w-5 h-5" />
					</Button>
					<Button className="rounded-full" onClick={toggle} size="icon">
						{isPlaying ? (
							<Pause className="w-5 h-5" />
						) : (
							<Play className="w-5 h-5" />
						)}
					</Button>
					<Button size="icon" variant="ghost">
						<SkipForward className="w-5 h-5" />
					</Button>
				</div>

				<div className="w-1/3 flex justify-end">
					{/* Volume control or other controls could go here */}
				</div>

				<audio
					onEnded={() => {
						// Handle end of song (next song)
					}}
					ref={audioRef}
					src={streamUrl || ""}
				/>
			</div>
		</div>
	);
}
