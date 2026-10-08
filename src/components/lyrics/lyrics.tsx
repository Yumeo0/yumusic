import { AudioLines, MicVocal } from "lucide-react";
import {
	type CSSProperties,
	memo,
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { readingSegments, wordProgress } from "@/lib/lyrics/fill";
import {
	fetchSyncedLyrics,
	type LrcLine,
	type LrcWord,
} from "@/lib/lyrics/lrclib";
import { fetchLrcRedLyrics } from "@/lib/lyrics/lrcred";
import {
	LYRICS_KIND_LABELS,
	LYRICS_PROVIDERS,
	type LyricsKind,
	type LyricsProviderId,
	lyricsKind,
	pickProvider,
} from "@/lib/lyrics/lyrics-providers";
import { fetchMusixmatchSynced } from "@/lib/lyrics/musixmatch";
import { useRomanizedLines } from "@/lib/lyrics/romanize";
import { fetchVocadbLyrics } from "@/lib/lyrics/vocadb";
import { useSettings } from "@/lib/stores/settings";
import { cn } from "@/lib/utils/utils";
import { getSongLyrics } from "@/lib/youtube/youtube-client";

interface LyricsPanelProps {
	songId: string;
	title: string;
	artist: string;
	/** Track duration in seconds (0 when unknown) */
	duration: number;
	/** Current playback time in seconds */
	currentTime: number;
	onSeekTime: (seconds: number) => void;
	/** The playing media element — sampled per frame for the word fills. */
	videoRef?: RefObject<HTMLVideoElement | null> | null;
	className?: string;
}

interface ProviderLyrics {
	synced: LrcLine[] | null;
	plain: string | null;
	/** Matched on artist + title (or authoritative), not a loose match. */
	confirmed: boolean;
}

/**
 * Per-provider result: `undefined` while the fetch is still in flight, `null`
 * once it settled without lyrics. Each provider fills in as it resolves, so
 * fast sources show up without waiting for the slowest one.
 */
type LyricsSources = Record<
	LyricsProviderId,
	ProviderLyrics | null | undefined
>;

const PROVIDER_BY_ID = new Map(LYRICS_PROVIDERS.map((p) => [p.id, p]));

const PENDING_SOURCES: LyricsSources = {
	lrclib: undefined,
	musixmatch: undefined,
	vocadb: undefined,
	youtube: undefined,
	lrcred: undefined,
};

/** Tooltips for the sync-kind badge in the header. */
const KIND_TITLES: Record<LyricsKind, string> = {
	plain: "No timing — shown as plain text",
	synced: "Timed line by line",
	word: "Every word is timed, karaoke-style",
};

/**
 * Full-height lyrics panel. Fetches synced lyrics (LRCLIB, Musixmatch,
 * lrc.red, and YouTube Music's timed lyrics) plus static YouTube Music and
 * VocaDB lyrics in parallel, lets the user switch between the providers,
 * optionally shows romanization under each line, and falls back to a quiet
 * placeholder when nothing is available.
 */
export function LyricsPanel({
	songId,
	title,
	artist,
	duration,
	currentTime,
	onSeekTime,
	videoRef,
	className,
}: LyricsPanelProps) {
	const [sources, setSources] = useState<LyricsSources>(PENDING_SOURCES);
	const [view, setView] = useState<LyricsProviderId>("lrclib");
	const [settings] = useSettings();
	// A manual provider pick sticks for the current track (until the next song).
	const manualView = useRef(false);

	useEffect(() => {
		let cancelled = false;
		setSources(PENDING_SOURCES);
		manualView.current = false;

		// Each provider lands on its own; a failing fetch counts as "none".
		const settle = <T,>(
			id: LyricsProviderId,
			request: Promise<T>,
			toLyrics: (result: T) => ProviderLyrics | null,
		) => {
			request
				.then(toLyrics, () => null)
				.then((lyrics) => {
					if (!cancelled) setSources((prev) => ({ ...prev, [id]: lyrics }));
				});
		};

		settle(
			"lrclib",
			fetchSyncedLyrics(title, artist, duration, settings.lrclibLooseMatch),
			(lrclib) => (lrclib && (lrclib.synced || lrclib.plain) ? lrclib : null),
		);
		settle(
			"musixmatch",
			fetchMusixmatchSynced(title, artist, duration),
			(musixmatch) =>
				musixmatch && musixmatch.length > 0
					? { synced: musixmatch, plain: null, confirmed: true }
					: null,
		);
		settle("youtube", getSongLyrics(songId), (youtube) =>
			youtube && (youtube.synced || youtube.plain)
				? { synced: youtube.synced, plain: youtube.plain, confirmed: true }
				: null,
		);
		settle("vocadb", fetchVocadbLyrics(title, artist, duration), (vocadb) =>
			vocadb ? { synced: null, plain: vocadb, confirmed: true } : null,
		);
		settle(
			"lrcred",
			fetchLrcRedLyrics(title, artist, duration),
			(lrcred) => lrcred,
		);

		return () => {
			cancelled = true;
		};
	}, [songId, title, artist, duration, settings.lrclibLooseMatch]);

	// Provider order is user-configurable, so selection re-runs when it changes.
	const order = settings.lyricsProviderOrder;
	const preferSynced = settings.preferSyncedLyrics;

	// Pick the provider (respecting manual picks) among the sources that have
	// arrived so far; re-runs as more land, so a better match that resolves
	// later takes over. A confirmed match beats a loose one, word-synced
	// lyrics beat line-synced ones; ties keep the priority order.
	useEffect(() => {
		const chosen = pickProvider(order, sources, preferSynced);
		if (chosen === null) return;
		if (manualView.current && sources[view]) return;
		setView(chosen);
	}, [sources, order, preferSynced, view]);

	const romanize = settings.romanizeLyrics;
	const available = order.flatMap((id) => {
		const provider = PROVIDER_BY_ID.get(id);
		if (!provider || !sources[id]) return [];
		return [provider];
	});
	const pending = order.some((id) => sources[id] === undefined);
	// The view can briefly point at a provider that hasn't arrived (or has
	// none) until the selection effect catches up.
	const active = sources[view] ?? null;
	const attribution = PROVIDER_BY_ID.get(view)?.attribution;
	const kind = active ? lyricsKind(active) : null;

	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			{/* Header + provider toggle */}
			<div className="mb-4 flex items-center gap-2">
				<MicVocal className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="text-xs font-medium text-muted-foreground">
					Lyrics
				</span>
				{kind && (
					<span
						className="animate-in fade-in rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
						title={KIND_TITLES[kind]}
					>
						{LYRICS_KIND_LABELS[kind]}
					</span>
				)}
				{active && !active.confirmed && (
					<span
						className="animate-in fade-in rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
						title="Matched by title alone — may be a different version of this song"
					>
						Loose match
					</span>
				)}
				{available.length >= 2 && (
					<div className="ml-auto flex items-center gap-0.5 rounded-full bg-foreground/6 p-0.5">
						{available.map((provider) => (
							<button
								className={cn(
									"animate-in fade-in rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-150",
									view === provider.id
										? "bg-background text-foreground shadow-sm"
										: "text-muted-foreground hover:text-foreground",
								)}
								key={provider.id}
								onClick={() => {
									manualView.current = true;
									setView(provider.id);
								}}
								type="button"
							>
								{provider.label}
							</button>
						))}
					</div>
				)}
			</div>
			{!active && pending && <LyricsSkeleton />}
			{active?.synced && (
				<SyncedLines
					attribution={attribution}
					currentTime={currentTime}
					lines={active.synced}
					onSeekTime={onSeekTime}
					romanize={romanize}
					videoRef={videoRef}
				/>
			)}
			{active && !active.synced && active.plain && (
				<LyricsLines
					attribution={attribution}
					romanize={romanize}
					text={active.plain}
				/>
			)}
			{!pending && available.length === 0 && <LyricsFallback />}
		</div>
	);
}

function SyncedLines({
	lines,
	currentTime,
	onSeekTime,
	romanize,
	attribution,
	videoRef,
}: {
	lines: LrcLine[];
	currentTime: number;
	onSeekTime: (seconds: number) => void;
	romanize: boolean;
	attribution?: string;
	videoRef?: RefObject<HTMLVideoElement | null> | null;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	// Visual anchor per line index: the line itself, or the dots row that
	// replaces it during silence
	const anchorRefs = useRef<Array<HTMLElement | null>>([]);
	// Pauses auto-scroll briefly while the user scrolls manually
	const holdUntilRef = useRef(0);
	const lineTexts = useMemo(() => lines.map((l) => l.text), [lines]);
	const romanized = useRomanizedLines(lineTexts, romanize);
	// Romaji spacing stays reserved while pending; dropped once there is
	// nothing to show (Latin-script lyrics, or every reading matches).
	const showRomaji = romanize && romanized?.size !== 0;

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

	// Auto-scroll is animated by hand rather than with `behavior: "smooth"`:
	// Chromium on Windows (WebView2) drops smooth programmatic scrolling
	// whenever the OS animation/smooth-scroll setting is off, so the lyrics
	// jumped line to line on desktop while Android eased them.
	const scrollFrameRef = useRef(0);
	const stopScroll = useCallback(() => {
		cancelAnimationFrame(scrollFrameRef.current);
		scrollFrameRef.current = 0;
	}, []);
	useEffect(() => stopScroll, [stopScroll]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		// Center the first line before playback reaches its timestamp too
		const idx = activeIndex < 0 ? 0 : activeIndex;
		const el = anchorRefs.current[idx];
		if (!el) return;
		if (Date.now() < holdUntilRef.current) return;
		const max = container.scrollHeight - container.clientHeight;
		const target = Math.min(
			max,
			Math.max(
				0,
				el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
			),
		);
		stopScroll();
		const from = container.scrollTop;
		const distance = target - from;
		if (Math.abs(distance) < 1) return;
		// Long jumps (seeks, first load) get a bit more time, capped.
		const duration = Math.min(900, 450 + Math.abs(distance) * 0.25);
		const start = performance.now();
		const tick = (now: number) => {
			const t = Math.min((now - start) / duration, 1);
			// easeInOutCubic: settles like the browser's smooth scroll
			const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
			container.scrollTop = from + distance * eased;
			scrollFrameRef.current = t < 1 ? requestAnimationFrame(tick) : 0;
		};
		scrollFrameRef.current = requestAnimationFrame(tick);
	}, [activeIndex, stopScroll]);

	// Manual scrolling wins: stop any running glide and pause auto-scroll.
	const hold = () => {
		stopScroll();
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
			data-swipe-dismiss-ignore
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
					if (line.words && line.words.length > 0) {
						return (
							<WordSyncLyricLine
								activeTime={seg.index === activeIndex ? currentTime : undefined}
								endTime={lines[seg.index + 1]?.time}
								index={seg.index}
								isActive={seg.index === activeIndex}
								key={`lrc-${seg.index}`}
								onRef={setAnchor}
								onSeekTime={onSeekTime}
								romanize={showRomaji}
								romanizedText={romanized?.get(seg.index)}
								time={line.time}
								videoRef={videoRef}
								words={line.words}
							/>
						);
					}
					return (
						<LyricLine
							index={seg.index}
							isActive={seg.index === activeIndex}
							key={`lrc-${seg.index}`}
							onRef={setAnchor}
							onSeekTime={onSeekTime}
							romanize={showRomaji}
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
				"cursor-pointer text-[26px] leading-snug font-medium tracking-tight transition-colors duration-500 py-3",
				isActive
					? "text-foreground [text-shadow:0_0_24px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
					: "text-foreground/25 hover:text-foreground/60",
			)}
			onClick={() => onSeekTime(time)}
			ref={(el) => onRef(index, el)}
		>
			{isActive && text
				? Array.from(text).map((char, ci) =>
						// Plain spaces stay outside the spans so line breaks still
						// happen at word boundaries, and inline spans keep font
						// shaping (kerning, CJK punctuation) intact.
						char === " " ? (
							" "
						) : (
							<span
								className="relative inline animate-char-wave"
								// biome-ignore lint/suspicious/noArrayIndexKey: positional wave, characters never reorder
								key={`c-${ci}`}
								style={{ animationDelay: `${ci * 30}ms` }}
							>
								{char}
							</span>
						),
					)
				: text}
			{romanize && romanizedText && (
				<span className="mt-1 block text-sm leading-normal font-normal text-foreground/45">
					{romanizedText}
				</span>
			)}
		</p>
	);
});

/**
 * The word line's playback position at display rate. The panel's
 * `currentTime` prop only updates on `timeupdate` (~4Hz), which steps the
 * fill; while the line is active the media element is sampled once per
 * animation frame instead, so re-renders stay inside the line component.
 * Returns undefined while the line is inactive (all words stay dim).
 */
function useLivePosition(
	videoRef: RefObject<HTMLVideoElement | null> | null | undefined,
	activeTime: number | undefined,
): number | undefined {
	const [position, setPosition] = useState(0);
	const active = activeTime !== undefined;

	useEffect(() => {
		if (!active || !videoRef) return;
		const videoEl = videoRef.current;
		if (videoEl) setPosition(videoEl.currentTime);
		let frame = requestAnimationFrame(function tick() {
			const media = videoRef.current;
			if (media) setPosition(media.currentTime);
			frame = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(frame);
	}, [active, videoRef]);

	// Without a media element, fall back to the prop clock.
	if (!active) return undefined;
	return videoRef ? position : activeTime;
}

/** Last-resort fill window for a word with no end and no following word. */
const WORD_TAIL_SEC = 0.6;

/** Karaoke fill of a span: lit up to `progress`, with a glow on the fill. */
function fillStyle(progress: number, dim: number): CSSProperties {
	return {
		backgroundImage: `linear-gradient(to right, var(--foreground) ${
			progress * 100
		}%, color-mix(in oklab, var(--foreground) ${dim}%, transparent) ${
			progress * 100
		}%)`,
		backgroundClip: "text",
		WebkitBackgroundClip: "text",
		color: "transparent",
		WebkitTextFillColor: "transparent",
		filter:
			"drop-shadow(0 0 12px color-mix(in oklab, var(--primary) 35%, transparent))",
	};
}

/**
 * A word-synced lyric line: every word fills with the highlight from left to
 * right while it is being sung (start → end time), upcoming words stay dim,
 * finished words are lit — and the romanized reading below fills along with
 * it. Only the active line receives a live position, so the other (often
 * many) word lines keep the memoized rendering and don't re-render on every
 * clock tick.
 */
const WordSyncLyricLine = memo(function WordSyncLyricLine({
	words,
	activeTime,
	endTime,
	time,
	index,
	isActive,
	romanize,
	romanizedText,
	onSeekTime,
	onRef,
	videoRef,
}: {
	words: LrcWord[];
	/** Playback position while this line is active; undefined otherwise. */
	activeTime?: number;
	/** The next line's start, bounding the fill of a final word without end. */
	endTime?: number;
	time: number;
	index: number;
	isActive: boolean;
	romanize: boolean;
	romanizedText?: string;
	onSeekTime: (seconds: number) => void;
	onRef: (index: number, el: HTMLParagraphElement | null) => void;
	videoRef?: RefObject<HTMLVideoElement | null> | null;
}) {
	const position = useLivePosition(videoRef, activeTime);

	// A word without an end lasts until the next one starts — the line's end
	// for the final word, or a short tail when even that is unknown.
	const ends = words.map(
		(word, wi) =>
			word.end ?? words[wi + 1]?.time ?? endTime ?? word.time + WORD_TAIL_SEC,
	);

	// The reading fills with the same timing, weighted by each chunk's text
	// length: the fraction of the romaji that is sung at the current position.
	let readingProgress = 0;
	if (position !== undefined) {
		const total = words.reduce((sum, word) => sum + word.text.trim().length, 0);
		if (total > 0) {
			let sung = 0;
			for (let i = 0; i < words.length; i++) {
				sung +=
					wordProgress(words[i].time, ends[i], position) *
					words[i].text.trim().length;
			}
			readingProgress = sung / total;
		}
	}

	return (
		<p
			className={cn(
				"cursor-pointer py-3 text-[26px] leading-snug font-medium tracking-tight transition-colors duration-500",
				!isActive && "text-foreground/25 hover:text-foreground/60",
			)}
			onClick={() => onSeekTime(time)}
			ref={(el) => onRef(index, el)}
		>
			{words.map((word, wi) => {
				const progress =
					position === undefined
						? 0
						: wordProgress(word.time, ends[wi], position);
				return (
					<span
						className={cn(
							"relative inline",
							progress <= 0 && "text-foreground/25",
						)}
						// biome-ignore lint/suspicious/noArrayIndexKey: positional word, times may repeat on synthetic syllabus
						key={`w-${wi}`}
						onClick={(event) => {
							event.stopPropagation();
							onSeekTime(word.time);
						}}
						style={progress > 0 ? fillStyle(progress, 25) : undefined}
					>
						{word.text}
					</span>
				);
			})}
			{romanize && romanizedText && (
				<span className="mt-1 block text-sm leading-normal font-normal text-foreground/45">
					{position === undefined
						? romanizedText
						: readingSegments(romanizedText, readingProgress).map((segment) =>
								segment.sung === undefined ? (
									segment.text
								) : (
									<span
										className="relative inline"
										key={`r-${segment.start}`}
										style={
											segment.sung > 0 ? fillStyle(segment.sung, 45) : undefined
										}
									>
										{segment.text}
									</span>
								),
							)}
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
	const showRomaji = romanize && romanized?.size !== 0;

	return (
		<div
			className="no-scrollbar fade-mask-y relative min-h-0 flex-1 overflow-y-auto pr-2"
			data-swipe-dismiss-ignore
		>
			<div className="pb-24 pt-10">
				{lines.map((line, i) =>
					line.trim() === "" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: static lyrics lines, list never reorders
						<div className="h-5" key={`gap-${i}`} />
					) : (
						<p
							className={cn(
								"cursor-default text-[26px] leading-snug font-medium tracking-tight text-foreground/25 transition-colors duration-200 hover:text-foreground",
								showRomaji ? "py-3" : "py-2.5",
								i === 0 && "text-foreground/70",
							)}
							// biome-ignore lint/suspicious/noArrayIndexKey: static lyrics lines, list never reorders
							key={`line-${i}`}
						>
							{line}
							{showRomaji && romanized?.get(i) && (
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
 * Three white dots representing extended silence in the lyrics. The dots
 * always bounce up and down; with `looping` they also fill sequentially on a
 * loop, otherwise `progress` (0-1) fills them up in sync with the song time.
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
							looping ? "animate-dot-fill" : "animate-dot-wave",
						)}
						key={d}
						style={{ animationDelay: `${d * (looping ? 0.35 : 0.18)}s` }}
					/>
				);
			})}
		</span>
	);
}

/** Detects silence-only LRC lines ("♪", empty, etc.). */
function isSilentLine(text: string): boolean {
	const s = text.trim();
	return s === "" || /^[♪♫*●○]+$/u.test(s);
}
