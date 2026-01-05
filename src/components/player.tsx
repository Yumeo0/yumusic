import {
	Pause,
	Play,
	SkipBack,
	SkipForward,
	Volume2,
	VolumeX,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { usePlayer } from "@/contexts/player-context";

export function Player() {
	const { currentSong, isPlaying, toggle, streamUrl } = usePlayer();
	const audioRef = useRef<HTMLAudioElement>(null);
	const progressBarRef = useRef<HTMLDivElement>(null);
	const maxVolume = 0.3;
	const [volume, setVolume] = useState(maxVolume);
	const [showVolumeSlider, setShowVolumeSlider] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const [isDragging, setIsDragging] = useState(false);

	// Convert linear slider value to exponential volume
	const linearToExponential = (linear: number) => {
		// Using exponential curve: volume = (e^(linear) - 1) / (e - 1)
		return ((Math.exp(linear) - 1) / (Math.E - 1)) * maxVolume;
	};

	// Convert exponential volume to linear slider value
	const exponentialToLinear = (exponential: number) => {
		// Inverse: linear = ln((exponential / maxVolume) * (e - 1) + 1)
		return Math.log((exponential / maxVolume) * (Math.E - 1) + 1);
	};

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
	}, [isPlaying]);

	useEffect(() => {
		if (audioRef.current) {
			audioRef.current.volume = volume;
		}
	}, [volume]);

	const toggleMute = () => {
		setVolume(volume === 0 ? maxVolume : 0);
	};

	const handleVolumeChange = (linear: number) => {
		setVolume(linearToExponential(linear));
	};

	const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
		if (!audioRef.current || !progressBarRef.current) return;
		const rect = progressBarRef.current.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const percentage = x / rect.width;
		const newTime = percentage * duration;
		audioRef.current.currentTime = newTime;
		setCurrentTime(newTime);
	};

	const handleProgressDrag = useCallback(
		(e: MouseEvent | React.MouseEvent<HTMLDivElement>) => {
			if (!isDragging || !audioRef.current || !progressBarRef.current) return;
			const rect = progressBarRef.current.getBoundingClientRect();
			const x = e.clientX - rect.left;
			const percentage = Math.max(0, Math.min(1, x / rect.width));
			const newTime = percentage * duration;
			audioRef.current.currentTime = newTime;
			setCurrentTime(newTime);
		},
		[isDragging, duration],
	);

	const handleProgressMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
		e.preventDefault();
		setIsDragging(true);
		handleProgressClick(e);
	};

	const handleProgressMouseUp = () => {
		setIsDragging(false);
	};

	useEffect(() => {
		const handleGlobalMouseMove = (e: MouseEvent) => {
			if (isDragging) {
				handleProgressDrag(e);
			}
		};
		const handleGlobalMouseUp = () => setIsDragging(false);

		window.addEventListener("mousemove", handleGlobalMouseMove);
		window.addEventListener("mouseup", handleGlobalMouseUp);
		return () => {
			window.removeEventListener("mousemove", handleGlobalMouseMove);
			window.removeEventListener("mouseup", handleGlobalMouseUp);
		};
	}, [isDragging, handleProgressDrag]);

	if (!currentSong) return null;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Hover effect needed for volume slider
		<section
			className="fixed bottom-0 left-0 right-0 bg-background border-t z-50"
			onMouseEnter={() => setShowVolumeSlider(true)}
			onMouseLeave={() => setShowVolumeSlider(false)}
		>
			{/* Progress bar */}
			<div
				aria-valuemax={duration}
				aria-valuemin={0}
				aria-valuenow={currentTime}
				className="w-full h-1 bg-secondary cursor-pointer relative group select-none"
				onClick={handleProgressClick}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						const mouseEvent = new MouseEvent("click", {
							clientX: (e.target as HTMLElement).getBoundingClientRect().left,
						});
						handleProgressClick(
							mouseEvent as unknown as React.MouseEvent<HTMLDivElement>,
						);
					}
				}}
				onMouseDown={handleProgressMouseDown}
				onMouseMove={handleProgressDrag}
				onMouseUp={handleProgressMouseUp}
				ref={progressBarRef}
				role="slider"
				tabIndex={0}
			>
				<div
					className="h-full bg-primary transition-none relative"
					style={{
						width: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
					}}
				>
					<div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-primary rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
				</div>
			</div>

			<div className="container mx-auto flex items-center justify-between p-4">
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
					<div className="relative flex items-center">
						{showVolumeSlider && (
							<div className="absolute right-full mr-2 top-1/2 -translate-y-1/2 py-6">
								<input
									className="w-24 h-2 appearance-none bg-transparent cursor-pointer
										[&::-webkit-slider-runnable-track]:w-full [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:bg-secondary [&::-webkit-slider-runnable-track]:rounded-full
										[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:-mt-1
										[&::-moz-range-track]:w-full [&::-moz-range-track]:h-2 [&::-moz-range-track]:bg-secondary [&::-moz-range-track]:rounded-full
										[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:border-0"
									max="1"
									min="0"
									onChange={(e) =>
										handleVolumeChange(Number.parseFloat(e.target.value))
									}
									step="0.01"
									type="range"
									value={exponentialToLinear(volume)}
								/>
							</div>
						)}
						<Button onClick={toggleMute} size="icon" variant="ghost">
							{volume === 0 ? (
								<VolumeX className="size-6" />
							) : (
								<Volume2 className="size-6" />
							)}
						</Button>
					</div>
				</div>

				<audio
					onEnded={() => {
						// Handle end of song (next song)
					}}
					onLoadedMetadata={(e) => {
						setDuration(e.currentTarget.duration);
					}}
					onTimeUpdate={(e) => {
						if (!isDragging) {
							setCurrentTime(e.currentTarget.currentTime);
						}
					}}
					ref={audioRef}
					src={streamUrl || ""}
				/>
			</div>
		</section>
	);
}
