import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils/utils";

interface ProgressBarProps {
	/** Playback progress from 0 to 1 */
	progress: number;
	className?: string;
	disabled?: boolean;
	onSeekStart?: () => void;
	/** Called continuously while scrubbing with the new percentage */
	onSeek?: (percent: number) => void;
	/** Called once when the scrub is released */
	onSeekCommit?: (percent: number) => void;
}

/** Standard seek bar: thin track, filled portion, thumb on hover. */
export function ProgressBar({
	progress,
	className,
	disabled = false,
	onSeekStart,
	onSeek,
	onSeekCommit,
}: ProgressBarProps) {
	const trackRef = useRef<HTMLDivElement>(null);
	const draggingRef = useRef(false);

	const clamped = Math.max(0, Math.min(1, progress));

	const percentFromClientX = useCallback((clientX: number): number => {
		const track = trackRef.current;
		if (!track) return 0;
		const rect = track.getBoundingClientRect();
		return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
	}, []);

	const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (disabled) return;
		e.preventDefault();
		draggingRef.current = true;
		trackRef.current?.setPointerCapture(e.pointerId);
		onSeekStart?.();
		onSeek?.(percentFromClientX(e.clientX));
	};

	const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current || disabled) return;
		onSeek?.(percentFromClientX(e.clientX));
	};

	const finishDrag = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!draggingRef.current) return;
		draggingRef.current = false;
		trackRef.current?.releasePointerCapture(e.pointerId);
		onSeekCommit?.(percentFromClientX(e.clientX));
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (disabled) return;
		const step = 0.05;
		if (e.key === "ArrowRight") {
			e.preventDefault();
			onSeekCommit?.(Math.min(1, clamped + step));
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			onSeekCommit?.(Math.max(0, clamped - step));
		}
	};

	return (
		<div
			aria-label="Seek"
			aria-valuemax={100}
			aria-valuemin={0}
			aria-valuenow={Math.round(clamped * 100)}
			className={cn(
				"group relative flex h-4 w-full touch-none select-none items-center",
				disabled ? "pointer-events-none opacity-60" : "cursor-pointer",
				className,
			)}
			onKeyDown={handleKeyDown}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={finishDrag}
			ref={trackRef}
			role="slider"
			tabIndex={disabled ? -1 : 0}
		>
			<div className="h-1 w-full overflow-hidden rounded-full bg-foreground/15 transition-colors group-hover:bg-foreground/25">
				<div
					className="h-full rounded-full bg-primary"
					style={{ width: `${clamped * 100}%` }}
				/>
			</div>
			<span
				aria-hidden
				className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-0 shadow transition-opacity duration-150 group-hover:opacity-100"
				style={{ left: `${clamped * 100}%` }}
			/>
		</div>
	);
}

interface EqualizerBarsProps {
	playing?: boolean;
	className?: string;
}

/** Small animated indicator shown next to the currently playing track. */
export function EqualizerBars({
	playing = true,
	className,
}: EqualizerBarsProps) {
	return (
		<span
			aria-hidden
			className={cn(
				"inline-flex h-3.5 items-end gap-[2px]",
				!playing && "opacity-40",
				className,
			)}
		>
			{[0, 1, 2].map((i) => (
				<span
					className={cn(
						"w-[3px] rounded-full bg-current origin-bottom",
						playing && "animate-eq",
					)}
					key={i}
					style={{
						height: `${[100, 62, 85][i]}%`,
						animationDelay: `${i * 140}ms`,
						animationDuration: `${0.9 + i * 0.22}s`,
					}}
				/>
			))}
		</span>
	);
}
