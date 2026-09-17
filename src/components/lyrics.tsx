import { AudioLines, MicVocal } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSyncedLyrics, type LrcLine } from "@/lib/lrclib";
import { fetchMusixmatchSynced } from "@/lib/musixmatch";
import { useRomanizedLines } from "@/lib/romanize";
import { useSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { getSongLyrics, type SongLyrics } from "@/lib/youtube-client";

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

interface LyricsSources {
	lrclib: LrcLine[] | null;
	musixmatch: LrcLine[] | null;
	youtube: SongLyrics | null;
}

type LyricsState =
	| { status: "loading" }
	| { status: "done"; sources: LyricsSources };

type LyricsView = "lrclib" | "musixmatch" | "youtube";

const LYRICS_PROVIDERS: Array<{
	id: LyricsView;
	label: string;
	attribution: string;
}> = [
	{ id: "lrclib", label: "LRCLIB", attribution: "LRCLIB" },
	{ id: "musixmatch", label: "Musixmatch", attribution: "Musixmatch" },
	{ id: "youtube", label: "YouTube", attribution: "YouTube Music" },
];

/**
 * Full-height lyrics panel. Fetches synced lyrics (LRCLIB, Musixmatch, and
 * YouTube Music's timed lyrics) plus static YouTube Music lyrics in parallel,
 * lets the user switch between the providers, optionally shows romanization
 * under each line, and falls back to a quiet placeholder when nothing is
 * available.
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
	const [settings] = useSettings();

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading" });
		setView("lrclib");

		const load = async () => {
			const [lrclib, musixmatch, youtube] = await Promise.all([
				fetchSyncedLyrics(title, artist, duration),
				fetchMusixmatchSynced(title, artist),
				getSongLyrics(songId),
			]);
			if (cancelled) return;
			const sources: LyricsSources = {
				lrclib: lrclib && lrclib.length > 0 ? lrclib : null,
				musixmatch: musixmatch && musixmatch.length > 0 ? musixmatch : null,
				youtube: youtube && (youtube.synced || youtube.plain) ? youtube : null,
			};
			setState({ status: "done", sources });
			const firstAvailable = LYRICS_PROVIDERS.find(
				(p) => sources[p.id as keyof LyricsSources] !== null,
			);
			if (firstAvailable) {
				setView(firstAvailable.id);
			}
		};
		load();

		return () => {
			cancelled = true;
		};
	}, [songId, title, artist, duration]);

	const romanize = settings.romanizeLyrics;
	const sources = state.status === "done" ? state.sources : null;
	const available = sources
		? LYRICS_PROVIDERS.filter(
				(p) => sources[p.id as keyof LyricsSources] !== null,
			)
		: [];
	const activeSynced =
		sources && view !== "youtube"
			? sources[view as Exclude<LyricsView, "youtube">]
			: (sources?.youtube?.synced ?? null);
	const attribution = LYRICS_PROVIDERS.find((p) => p.id === view)?.attribution;

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			{/* Header + provider toggle */}
			<div className="mb-4 flex items-center gap-2">
				<MicVocal className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">
					Lyrics
				</span>
				{available.length >= 2 && (
					<div className="ml-auto flex items-center gap-0.5 rounded-full bg-foreground/[0.06] p-0.5">
						{available.map((provider) => (
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
			{sources && activeSynced && (
				<SyncedLines
					attribution={attribution}
					currentTime={currentTime}
					lines={activeSynced}
					onSeekTime={onSeekTime}
					romanize={romanize}
				/>
			)}
			{sources && !activeSynced && sources.youtube?.plain && (
				<LyricsLines
					attribution={attribution}
					romanize={romanize}
					text={sources.youtube.plain}
				/>
			)}{" "}
			{sources &&
				!sources.lrclib &&
				!sources.musixmatch &&
				!sources.youtube && <LyricsFallback />}
		</div>
	);
}

function SyncedLines({
	lines,
	currentTime,
	onSeekTime,
	romanize,
	attribution,
}: {
	lines: LrcLine[];
	currentTime: number;
	onSeekTime: (seconds: number) => void;
	romanize: boolean;
	attribution?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	// Visual anchor per line index: the line itself, or the dots row that
	// replaces it during silence
	const anchorRefs = useRef<Array<HTMLElement | null>>([]);
	// Pauses auto-scroll briefly while the user scrolls manually
	const holdUntilRef = useRef(0);
	const lineTexts = useMemo(() => lines.map((l) => l.text), [lines]);
	const romanized = useRomanizedLines(lineTexts, romanize);

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
		const out: Array<
			| { kind: "line"; index: number }
			| {
					kind: "dots";
					from: number;
					to: number;
					start: number;
					end: number | null;
					key: string;
			  }
		> = [];
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

	// Stable so the memoized lines don't all re-render on every clock tick.
	const setAnchor = useCallback(
		(index: number, el: HTMLParagraphElement | null) => {
			anchorRefs.current[index] = el;
		},
		[],
	);

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
						<LyricLine
							index={seg.index}
							isActive={seg.index === activeIndex}
							key={`lrc-${seg.index}`}
							onRef={setAnchor}
							onSeekTime={onSeekTime}
							romanize={romanize}
							romanizedText={romanized?.get(seg.index)}
							text={line.text}
							time={line.time}
						/>
					);
				})}
				{attribution && <LyricsAttribution source={attribution} />}
			</div>
		</div>
	);
}

/**
 * One lyric line. Memoized on `isActive` so a clock tick only re-renders the
 * line that actually changed state instead of the whole (often long) list.
 */
const LyricLine = memo(function LyricLine({
	text,
	time,
	index,
	isActive,
	romanize,
	romanizedText,
	onSeekTime,
	onRef,
}: {
	text: string;
	time: number;
	index: number;
	isActive: boolean;
	romanize: boolean;
	romanizedText?: string;
	onSeekTime: (seconds: number) => void;
	onRef: (index: number, el: HTMLParagraphElement | null) => void;
}) {
	return (
		<p
			className={cn(
				"cursor-pointer text-[26px] leading-snug font-medium tracking-tight transition-colors duration-500",
				romanize ? "py-3" : "py-1.5",
				isActive
					? "text-foreground [text-shadow:0_0_24px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
					: "text-foreground/25 hover:text-foreground/60",
			)}
			onClick={() => onSeekTime(time)}
			ref={(el) => onRef(index, el)}
		>
			{isActive && text
				? text.split("").map((char, ci) => (
						<span
							className="inline-block animate-char-wave"
							// biome-ignore lint/suspicious/noArrayIndexKey: positional wave, characters never reorder
							key={`c-${ci}`}
							style={{ animationDelay: `${ci * 30}ms` }}
						>
							{char === " " ? "\u00A0" : char}
						</span>
					))
				: text}
			{romanize && romanizedText && (
				<span className="mt-1 block text-sm leading-normal font-normal text-foreground/45">
					{romanizedText}
				</span>
			)}
		</p>
	);
});

function LyricsLines({
	text,
	romanize,
	attribution,
}: {
	text: string;
	romanize: boolean;
	attribution?: string;
}) {
	const lines = useMemo(() => text.split("\n"), [text]);
	const romanized = useRomanizedLines(lines, romanize);

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
								"cursor-default text-[26px] leading-snug font-medium tracking-tight text-foreground/25 transition-colors duration-200 hover:text-foreground",
								romanize ? "py-3" : "py-1.5",
								i === 0 && "text-foreground/70",
							)}
							// biome-ignore lint/suspicious/noArrayIndexKey: static lyrics lines, list never reorders
							key={`line-${i}`}
						>
							{line}
							{romanize && romanized?.get(i) && (
								<span className="mt-1 block text-base leading-normal font-normal text-foreground/45">
									{romanized.get(i)}
								</span>
							)}
						</p>
					),
				)}
				{attribution && <LyricsAttribution source={attribution} />}
			</div>
		</div>
	);
}

function LyricsAttribution({ source }: { source: string }) {
	return (
		<p className="mt-8 text-[11px] text-muted-foreground/50">
			Lyrics via {source}
		</p>
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
			<AudioLines className="mb-4 size-8 text-muted-foreground/60" />
			<p className="text-sm font-medium text-muted-foreground/60">
				No lyrics available
			</p>
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

/** Detects silence-only LRC lines ("♪", empty, etc.). */
function isSilentLine(text: string): boolean {
	const s = text.trim();
	return s === "" || /^[♪*●○]+$/u.test(s);
}
