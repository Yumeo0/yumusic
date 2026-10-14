import { For } from "solid-js";
import { cn } from "@/lib/utils/utils";

interface ProgressBarProps {
	/** Playback progress from 0 to 1 */
	progress: number;
	class?: string;
	disabled?: boolean;
	onSeekStart?: () => void;
	/** Called continuously while scrubbing with the new percentage */
	onSeek?: (percent: number) => void;
	/** Called once when the scrub is released */
	onSeekCommit?: (percent: number) => void;
}

/** Standard seek bar: thin track, filled portion, thumb on hover. */
export function ProgressBar(props: ProgressBarProps) {
	let track!: HTMLDivElement;
	let dragging = false;

	const clamped = () => Math.max(0, Math.min(1, props.progress));

	const percentFromClientX = (clientX: number): number => {
		if (!track) return 0;
		const rect = track.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	};

	const handlePointerDown = (event: PointerEvent) => {
		if (props.disabled) return;
		event.preventDefault();
		dragging = true;
		track.setPointerCapture(event.pointerId);
		props.onSeekStart?.();
		props.onSeek?.(percentFromClientX(event.clientX));
	};

	const handlePointerMove = (event: PointerEvent) => {
		if (!dragging || props.disabled) return;
		props.onSeek?.(percentFromClientX(event.clientX));
	};

	const finishDrag = (event: PointerEvent) => {
		if (!dragging) return;
		dragging = false;
		track.releasePointerCapture(event.pointerId);
		props.onSeekCommit?.(percentFromClientX(event.clientX));
	};

	const handleKeyDown = (event: KeyboardEvent) => {
		if (props.disabled) return;
		const step = 0.05;
		if (event.key === "ArrowRight") {
			event.preventDefault();
			props.onSeekCommit?.(Math.min(1, clamped() + step));
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			props.onSeekCommit?.(Math.max(0, clamped() - step));
		}
	};

	return (
		// biome-ignore lint/a11y/useFocusableInteractive: focusable unless disabled (tabindex is set below)
		<div
			aria-label="Seek"
			aria-valuemax={100}
			aria-valuemin={0}
			aria-valuenow={Math.round(clamped() * 100)}
			class={cn(
				"group relative flex h-4 w-full touch-none select-none items-center",
				props.disabled ? "pointer-events-none opacity-60" : "cursor-pointer",
				props.class,
			)}
			onKeyDown={handleKeyDown}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={finishDrag}
			ref={track}
			role="slider"
			tabindex={props.disabled ? -1 : 0}
		>
			<div class="h-1 w-full overflow-hidden rounded-full bg-foreground/15 transition-colors group-hover:bg-foreground/25">
				<div
					class="h-full rounded-full bg-primary"
					style={{ width: `${clamped() * 100}%` }}
				/>
			</div>
			<span
				aria-hidden="true"
				class="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity duration-150 group-hover:opacity-100"
				style={{ left: `${clamped() * 100}%` }}
			/>
		</div>
	);
}

interface EqualizerBarsProps {
	playing?: boolean;
	class?: string;
}

/** Small animated indicator shown next to the currently playing track. */
export function EqualizerBars(props: EqualizerBarsProps) {
	const playing = () => props.playing ?? true;
	return (
		<span
			aria-hidden="true"
			class={cn(
				"inline-flex h-3.5 items-end gap-[2px]",
				!playing() && "opacity-40",
				props.class,
			)}
		>
			<For each={[0, 1, 2]}>
				{(index) => (
					<span
						class={cn(
							"w-[3px] rounded-full bg-current origin-bottom",
							playing() && "animate-eq",
						)}
						style={{
							height: `${[100, 62, 85][index]}%`,
							"animation-delay": `${index * 140}ms`,
							"animation-duration": `${0.9 + index * 0.22}s`,
						}}
					/>
				)}
			</For>
		</span>
	);
}
