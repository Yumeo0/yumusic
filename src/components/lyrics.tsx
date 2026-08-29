import { AudioLines, MicVocal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSyncedLyrics, type LrcLine } from "@/lib/lrclib";
import { cn } from "@/lib/utils";
import { getSongLyrics } from "@/lib/youtube-client";

interface LyricsPanelProps {
	songId: string;
	title: string;
	artist: string;
	/** Track duration in seconds (0 when unknown) */
	duration: number;
	/** Current playback time in seconds */
	currentTime: number;
	onSeekTime: (seconds: number) => void;
	className?: string;
}

type LyricsState =
	| { status: "loading" }
	| { status: "done"; synced: LrcLine[] | null; plain: string | null };

type LyricsView = "lrclib" | "youtube";

/** Toggle options labeled by lyrics provider */
const LYRICS_PROVIDERS: Array<{ id: LyricsView; label: string }> = [
	{ id: "lrclib", label: "LRCLIB" },
	{ id: "youtube", label: "YouTube" },
];

/**
 * Full-height lyrics panel. Fetches time-synced lyrics (LRCLIB) and static
 * YouTube Music lyrics in parallel, lets the user switch between them,
 * and shows a quiet placeholder when neither exists.
 */
export function LyricsPanel({
	songId,
	title,
	artist,
	duration,
	currentTime,
	onSeekTime,
	className,
}: LyricsPanelProps) {
	const [state, setState] = useState<LyricsState>({ status: "loading" });
	const [view, setView] = useState<LyricsView>("lrclib");

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		setView("lrclib");

		const load = async () => {
			const [synced, plain] = await Promise.all([
				fetchSyncedLyrics(title, artist, duration),
				getSongLyrics(songId),
			]);
			if (cancelled) return;
			setState({
				status: "done",
				synced: synced && synced.length > 0 ? synced : null,
				plain,
			});
		};
		load();

		return () => {
			cancelled = true;
		};
	}, [songId, title, artist, duration]);

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			{/* Header + source toggle */}
			<div className="mb-4 flex items-center gap-2">
				<MicVocal className="size-3.5 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">
					Lyrics
				</span>
				{state.status === "done" && state.synced && state.plain && (
					<div className="ml-auto flex items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5">
						{LYRICS_PROVIDERS.map((provider) => (
							<button
								className={cn(
									"rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-150",
									view === provider.id
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
								key={provider.id}
								onClick={() => setView(provider.id)}
								type="button"
							>
								{provider.label}
							</button>
						))}
					</div>
				)}
			</div>

			{state.status === "loading" && <LyricsSkeleton />}
			{state.status === "done" && view === "lrclib" && state.synced && (
				<SyncedLines
					currentTime={currentTime}
					lines={state.synced}
					onSeekTime={onSeekTime}
				/>
			)}
			{state.status === "done" &&
				!(view === "lrclib" && state.synced) &&
				state.plain && <LyricsLines text={state.plain} />}
			{state.status === "done" && !state.synced && !state.plain && (
				<LyricsFallback />
			)}
		</div>
	);
}

/** Detects silence-only LRC lines ("♪", empty, etc.). */
function isSilentLine(text: string): boolean {
	const s = text.trim();
	return s === "" || /^[♪*●○]+$/u.test(s);
}

type LyricSegment =
	| { kind: "line"; index: number }
	| {
			kind: "dots";
			/** First line index replaced by the dots */
			from: number;
			/** Last line index replaced by the dots */
			to: number;
			/** Time (s) the dots appear — instantly when the silence starts */
			start: number;
			/** Time (s) the silence ends; null = unknown (looping fill) */
			end: number | null;
			/** Unique key */
			key: string;
	  };

function SyncedLines({
	lines,
	currentTime,
	onSeekTime,
}: {
	lines: LrcLine[];
	currentTime: number;
	onSeekTime: (seconds: number) => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	// Visual anchor per line index: the line itself, or the dots row that
	// replaces it during silence
	const anchorRefs = useRef<Array<HTMLElement | null>>([]);
	// Pauses auto-scroll briefly while the user scrolls manually
	const holdUntilRef = useRef(0);

	const activeIndex = useMemo(() => {
		let idx = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].time <= currentTime + 0.25) {
				idx = i;
			} else {
				break;
			}
		}
		return idx;
	}, [lines, currentTime]);

	// Build render segments: runs of silence-only lines ("♪"/empty) are
	// replaced by a single dots row; everything else renders as-is.
	const segments = useMemo(() => {
		const out: LyricSegment[] = [];
		let i = 0;
		while (i < lines.length) {
			if (isSilentLine(lines[i].text)) {
				const from = i;
				while (i < lines.length && isSilentLine(lines[i].text)) {
					i++;
				}
				const to = i - 1;
				out.push({
					kind: "dots",
					from,
					to,
					start: lines[from].time,
					end:
						i < lines.length
							? Math.max(lines[i].time - 0.2, lines[from].time + 0.5)
							: null,
					key: `dots-${from}`,
				});
			} else {
				out.push({ kind: "line", index: i });
				i++;
			}
		}
		return out;
	}, [lines]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Center the first line before playback reaches its timestamp too
		const idx = activeIndex < 0 ? 0 : activeIndex;
		const el = anchorRefs.current[idx];
		if (!el) return;
		if (Date.now() < holdUntilRef.current) return;
		container.scrollTo({
			top: el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
			behavior: "smooth",
		});
	}, [activeIndex]);

	const hold = () => {
		holdUntilRef.current = Date.now() + 4000;
	};

	return (
		<div
			className="no-scrollbar fade-mask-y relative min-h-0 flex-1 overflow-y-auto pr-2"
			onTouchMove={hold}
			onWheel={hold}
			ref={containerRef}
		>
			{/* Half-viewport spacers so the first and last lines can truly center */}
			<div className="pb-[50vh] pt-[50vh]">
				{segments.map((seg) => {
					if (seg.kind === "dots") {
						// Only render while the silence is actually happening
						const visible =
							currentTime >= seg.start &&
							(seg.end === null || currentTime < seg.end);
						if (!visible) return null;
						const progress =
							seg.end === null
								? 0
								: Math.min(
										1,
										Math.max(
											0,
											(currentTime - seg.start) / (seg.end - seg.start),
										),
									);
						return (
							<div
								key={seg.key}
								ref={(el) => {
									for (let k = seg.from; k <= seg.to; k++) {
										anchorRefs.current[k] = el;
									}
								}}
							>
								<PauseDots looping={seg.end === null} progress={progress} />
							</div>
						);
					}
					const line = lines[seg.index];
					return (
						<p
							className={cn(
								"cursor-pointer py-1.5 text-[26px] leading-snug font-medium tracking-tight transition-colors duration-500",
								seg.index === activeIndex
									? "text-foreground [text-shadow:0_0_24px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
									: "text-foreground/25 hover:text-foreground/60",
							)}
							key={`lrc-${seg.index}`}
							onClick={() => onSeekTime(line.time)}
							ref={(el) => {
								anchorRefs.current[seg.index] = el;
							}}
						>
							{seg.index === activeIndex && line.text
								? line.text.split("").map((char, ci) => (
										<span
											className="inline-block animate-char-wave"
											// biome-ignore lint/suspicious/noArrayIndexKey: positional wave, characters never reorder
											key={`c-${ci}`}
											style={{ animationDelay: `${ci * 30}ms` }}
										>
											{char === " " ? "\u00A0" : char}
										</span>
									))
								: line.text}
						</p>
					);
				})}
			</div>
		</div>
	);
}

/**
 * Three white dots representing extended silence in the lyrics.
 * With `looping` they fill sequentially on a loop; otherwise `progress`
 * (0-1) fills them up in sync with the song time.
 */
function PauseDots({
	progress,
	looping,
}: {
	progress: number;
	looping: boolean;
}) {
	return (
		<span aria-hidden className="flex items-center gap-1.5 py-2.5 pl-1">
			{[0, 1, 2].map((d) => {
				const filled = !looping && progress >= (d + 0.5) / 3;
				return (
					<span
						className={cn(
							"size-2 rounded-full bg-white/25",
							filled && "bg-white shadow-[0_0_8px_rgba(255,255,255,0.45)]",
							looping && "animate-dot-fill",
						)}
						key={d}
						style={looping ? { animationDelay: `${d * 0.35}s` } : undefined}
					/>
				);
			})}
		</span>
	);
}

function LyricsLines({ text }: { text: string }) {
	const lines = text.split("\n");

	return (
		<div className="no-scrollbar fade-mask-y relative min-h-0 flex-1 overflow-y-auto pr-2">
			<div className="pb-24 pt-10">
				{lines.map((line, i) =>
					line.trim() === "" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: static lyrics lines, list never reorders
						<div className="h-5" key={`gap-${i}`} />
					) : (
						<p
							className={cn(
								"cursor-default py-1.5 text-[26px] leading-snug font-medium tracking-tight text-foreground/25 transition-colors duration-200 hover:text-foreground",
								i === 0 && "text-foreground/70",
							)}
							// biome-ignore lint/suspicious/noArrayIndexKey: static lyrics lines, list never reorders
							key={`line-${i}`}
						>
							{line}
						</p>
					),
				)}
				<p className="mt-8 text-[11px] text-muted-foreground/50">
					Lyrics via YouTube Music
				</p>
			</div>
		</div>
	);
}

function LyricsSkeleton() {
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 pr-2">
			{[85, 65, 92, 58, 78, 88, 45, 70, 60].map((w, i) => (
				<div
					className="shimmer-surface h-6 rounded-md"
					// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
					key={i}
					style={{ width: `${w}%`, animationDelay: `${i * 120}ms` }}
				/>
			))}
		</div>
	);
}

function LyricsFallback() {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
			<AudioLines className="mb-4 size-8 text-muted-foreground/50" />
			<p className="text-sm font-medium text-muted-foreground/50">
				No lyrics available
			</p>
		</div>
	);
}
