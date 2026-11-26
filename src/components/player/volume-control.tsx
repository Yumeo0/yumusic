import { Volume1, Volume2, VolumeX } from "lucide-react";
import { useId } from "react";
import { usePlayerVolume } from "@/contexts/player-context";
import { linearToVolume, volumeToLinear } from "@/lib/player/volume";

export function VolumeSlider() {
	const { volume, setVolume, toggleMute } = usePlayerVolume();
	const id = useId();
	const linear = volumeToLinear(volume);
	const Icon = volume === 0 ? VolumeX : linear < 0.45 ? Volume1 : Volume2;
	return (
		<section aria-label="Volume controls" className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-3">
				<label className="text-sm font-medium" htmlFor={id}>
					Volume
				</label>
				<span className="text-xs text-muted-foreground tabular-nums">
					{Math.round(linear * 100)}%
				</span>
			</div>
			<div className="flex items-center gap-3">
				<button
					aria-label={volume === 0 ? "Unmute" : "Mute"}
					className="grid size-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
					onClick={toggleMute}
					title={volume === 0 ? "Unmute" : "Mute"}
					type="button"
				>
					<Icon aria-hidden className="size-4.5" />
				</button>
				<input
					aria-label="Volume"
					className="range-fx min-w-0 flex-1"
					id={id}
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
		</section>
	);
}
