import { Volume1, Volume2, VolumeX } from "lucide-react";
import { usePlayer } from "@/contexts/player-context";
import { linearToVolume, MAX_VOLUME, volumeToLinear } from "@/lib/hooks";
import { cn } from "@/lib/utils";

interface VolumeControlProps {
	className?: string;
	sliderClassName?: string;
	/** Renders the slider to the left of the icon (for right-anchored use) */
	reverse?: boolean;
}

/** Speaker icon + tinted range slider, bound to the player context volume. */
export function VolumeControl({
	className,
	sliderClassName,
	reverse = false,
}: VolumeControlProps) {
	const { volume, setVolume } = usePlayer();

	const linear = volumeToLinear(volume);
	const toggleMute = () => setVolume(volume > 0 ? 0 : MAX_VOLUME);

	const Icon =
		volume === 0 ? VolumeX : volume < MAX_VOLUME * 0.45 ? Volume1 : Volume2;

	return (
		<div
			className={cn(
				"group/vol flex items-center gap-2",
				reverse && "flex-row-reverse",
				className,
			)}
		>
			<button
				aria-label={volume === 0 ? "Unmute" : "Mute"}
				className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90"
				onClick={toggleMute}
				type="button"
			>
				<Icon className="size-[18px]" />
			</button>
			<input
				aria-label="Volume"
				className={cn(
					"range-fx w-0 opacity-0 transition-all duration-300 group-hover/vol:w-24 group-hover/vol:opacity-100 focus:w-24 focus:opacity-100",
					sliderClassName,
				)}
				max="1"
				min="0"
				onChange={(e) =>
					setVolume(linearToVolume(Number.parseFloat(e.target.value)))
				}
				step="0.01"
				style={{ "--vol": linear } as React.CSSProperties}
				type="range"
				value={linear}
			/>
		</div>
	);
}
