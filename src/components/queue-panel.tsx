import { ListMusic, X } from "lucide-react";
import { SongTitle } from "@/components/song-title";
import { usePlayer } from "@/contexts/player-context";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { ArtistLinks } from "./artist-link";
import { EqualizerBars } from "./waveform";

interface QueuePanelProps {
	open: boolean;
	onClose: () => void;
	/** In fullscreen the panel spans the full height */
	fullscreen?: boolean;
}

/** Right-side queue drawer, toggleable from the player bar and fullscreen. */
export function QueuePanel({
	open,
	onClose,
	fullscreen = false,
}: QueuePanelProps) {
	const { queue, currentIndex, isPlaying, play } = usePlayer();

	return (
		<aside
			className={cn(
				"fixed top-9 right-0 z-[60] flex w-80 flex-col border-l border-foreground/10 bg-background/85 backdrop-blur-xl transition-transform duration-300 ease-out max-md:inset-x-0 max-md:top-0 max-md:bottom-0 max-md:w-full max-md:border-l-0",
				fullscreen ? "bottom-0" : "bottom-[90px]",
				open ? "translate-x-0" : "pointer-events-none translate-x-full",
			)}
		>
			<div className="flex items-center justify-between border-b border-foreground/8 px-4 py-3.5">
				<div className="flex items-center gap-2.5">
					<ListMusic className="size-4 text-muted-foreground" />
					<span className="text-sm font-semibold">Queue</span>
					{queue.length > 0 && (
						<span className="rounded-full bg-foreground/[0.07] px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
							{queue.length}
						</span>
					)}
				</div>
				<button
					aria-label="Close queue"
					className="grid size-8 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<X className="size-4" />
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-2 max-md:pb-[calc(0.5rem+var(--safe-area-bottom))]">
				{queue.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground/70">
						Queue is empty — play something to fill it up.
					</p>
				) : (
					<div className="space-y-0.5">
						{queue.map((song, i) => {
							const isCurrent = i === currentIndex;
							return (
								<button
									className={cn(
										"group grid w-full grid-cols-[1.5rem_2.5rem_1fr_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-150",
										isCurrent
											? "bg-primary/[0.09]"
											: "hover:bg-foreground/[0.05]",
									)}
									// biome-ignore lint/suspicious/noArrayIndexKey: queue may contain duplicate video ids
									key={`queue-${song.id}-${i}`}
									onClick={() => play(song)}
									type="button"
								>
									<span className="relative grid place-items-center">
										{isCurrent ? (
											<EqualizerBars
												className="size-3.5 text-primary"
												playing={isPlaying}
											/>
										) : (
											<span className="font-mono text-[10px] text-muted-foreground/50 transition-opacity duration-150 group-hover:opacity-0">
												{i + 1}
											</span>
										)}
									</span>
									{song.thumbnail ? (
										<img
											alt=""
											className="size-10 rounded-md border border-foreground/10 object-cover"
											loading="lazy"
											src={proxiedImageUrl(song.thumbnail)}
										/>
									) : (
										<div className="size-10 rounded-md bg-muted" />
									)}
									<div className="min-w-0">
										<p
											className={cn(
												"truncate text-sm font-medium",
												isCurrent && "text-primary",
											)}
										>
											<SongTitle artist={song.artist} title={song.title} />
										</p>
										<p className="truncate text-xs text-muted-foreground">
											<ArtistLinks song={song} />
										</p>
									</div>
									{song.duration && (
										<span className="pr-1 font-mono text-[10px] text-muted-foreground/60 tabular-nums">
											{song.duration}
										</span>
									)}
								</button>
							);
						})}
					</div>
				)}
			</div>
		</aside>
	);
}
