import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef } from "react";
import { usePlayerVolume } from "@/contexts/player-context";
import { linearToVolume, MAX_VOLUME, volumeToLinear } from "@/lib/utils/hooks";
import { cn } from "@/lib/utils/utils";

interface VolumeControlProps {
	className?: string;
	sliderClassName?: string;
	/** Renders the slider to the left of the icon (for right-anchored use) */
	reverse?: boolean;
	/**
	 * No room to expand sideways: hovering the icon pops the slider up
	 * vertically on its own small backdrop instead of sliding it out inline.
	 */
	vertical?: boolean;
}

/** Speaker icon + tinted range slider, bound to the player context volume. */
export function VolumeControl({
	className,
	sliderClassName,
	reverse = false,
	vertical = false,
}: VolumeControlProps) {
	const { volume, setVolume } = usePlayerVolume();

	// Remember the last audible level so unmuting restores it instead of
	// jumping to full volume.
	const lastAudible = useRef(volume > 0 ? volume : MAX_VOLUME);
	useEffect(() => {
		if (volume > 0) lastAudible.current = volume;
	}, [volume]);

	const linear = volumeToLinear(volume);
	const toggleMute = () => setVolume(volume > 0 ? 0 : lastAudible.current);
	const setFromInput = (event: React.ChangeEvent<HTMLInputElement>) =>
		setVolume(linearToVolume(Number.parseFloat(event.target.value)));

	const Icon =
		volume === 0 ? VolumeX : volume < MAX_VOLUME * 0.45 ? Volume1 : Volume2;

	if (vertical) {
		return (
			<div className={cn("group/vol relative", className)}>
				<button
					aria-label={volume === 0 ? "Unmute" : "Mute"}
					className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground transition-all duration-200 hover:bg-foreground/8 hover:text-foreground active:scale-90"
					onClick={toggleMute}
					type="button"
				>
					<Icon className="size-[18px]" />
				</button>
				{/* Bottom padding bridges the hover area to the icon. Always
				    mounted so Tab can also reach and reveal the slider. */}
				<div className="pointer-events-none absolute right-0 bottom-full z-20 min-w-full pb-2 opacity-0 transition-opacity duration-200 group-focus-within/vol:pointer-events-auto group-focus-within/vol:opacity-100 group-hover/vol:pointer-events-auto group-hover/vol:opacity-100">
					<div className="mx-auto w-fit rounded-xl border border-foreground/10 bg-background/95 px-1 py-2.5 shadow-[0_12px_40px_-12px_oklch(0_0_0/0.6)] backdrop-blur-md">
						<div className="relative h-28 w-5">
							<input
								aria-label="Volume"
								className="range-fx absolute top-1/2 left-1/2 w-28 -translate-x-1/2 -translate-y-1/2 -rotate-90"
								max="1"
								min="0"
								onChange={setFromInput}
								step="0.01"
								style={{ "--vol": linear } as React.CSSProperties}
								type="range"
								value={linear}
							/>
						</div>
					</div>
				</div>
			</div>
		);
	}

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
				<Icon className="size-4.5" />
			</button>
			<input
				aria-label="Volume"
				className={cn(
					"range-fx w-0 opacity-0 transition-all duration-300 group-hover/vol:w-22 group-hover/vol:opacity-100 focus:w-22 focus:opacity-100",
					sliderClassName,
				)}
				max="1"
				min="0"
				onChange={setFromInput}
				step="0.01"
				style={{ "--vol": linear } as React.CSSProperties}
				type="range"
				value={linear}
			/>
		</div>
	);
}
