import { AudioLines, MicVocal } from "@lucide/solid";
import type { JSX } from "@solidjs/web";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	Show,
	untrack,
} from "solid-js";
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

/** Mutable holder for the media element sampled per frame. */
interface VideoRef {
	current: HTMLVideoElement | null;
}

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
	videoRef?: VideoRef | null;
	class?: string;
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
export function LyricsPanel(props: LyricsPanelProps) {
	const [sources, setSources] = createSignal<LyricsSources>(PENDING_SOURCES);
	const [view, setView] = createSignal<LyricsProviderId>("lrclib");
	const [settings] = useSettings();
	// A manual provider pick sticks for the current track (until the next song).
	let manualView = false;

	createEffect(
		() => ({
			artist: props.artist,
			duration: props.duration,
			loose: settings.lrclibLooseMatch,
			songId: props.songId,
			title: props.title,
		}),
		({ artist, duration, loose, songId, title }) => {
			let cancelled = false;
			setSources(PENDING_SOURCES);
			manualView = false;

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
				fetchSyncedLyrics(title, artist, duration, loose),
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
		},
	);

	// Pick the provider (respecting manual picks) among the sources that have
	// arrived so far; re-runs as more land, so a better match that resolves
	// later takes over. A confirmed match beats a loose one, word-synced
	// lyrics beat line-synced ones; ties keep the priority order.
	createEffect(
		() => ({
			order: settings.lyricsProviderOrder,
			prefer: settings.preferSyncedLyrics,
			sources: sources(),
		}),
		({ order, prefer, sources: current }) => {
			const chosen = pickProvider(order, current, prefer);
			if (chosen === null) return;
			// Read the current pick untracked: tracking it here would make the
			// setView below feed back into this effect's own inputs. A manual
			// pick always comes from the available list, so it has sources.
			if (manualView && current[untrack(view)]) return;
			setView(chosen);
		},
	);

	// The view can briefly point at a provider that hasn't arrived (or has
	// none) until the selection effect catches up.
	const active = () => sources()[view()] ?? null;
	const attribution = () => PROVIDER_BY_ID.get(view())?.attribution;
	const kind = () => {
		const current = active();
		return current ? lyricsKind(current) : null;
	};
	const available = createMemo(() =>
		settings.lyricsProviderOrder.flatMap((id) => {
			const provider = PROVIDER_BY_ID.get(id);
			if (!provider || !sources()[id]) return [];
			return [provider];
		}),
	);
	const pending = createMemo(() =>
		settings.lyricsProviderOrder.some((id) => sources()[id] === undefined),
	);
	const activeSynced = () => active()?.synced ?? null;
	const activePlain = () => {
		const current = active();
		return current && !current.synced && current.plain ? current.plain : null;
	};
	const activeUnconfirmed = () => {
		const current = active();
		return current && !current.confirmed ? current : null;
	};

	return (
		<div class={cn("flex h-full min-h-0 flex-col", props.class)}>
			{/* Header + provider toggle */}
			<div class="mb-4 flex items-center gap-2">
				<MicVocal class="size-3.5 shrink-0 text-muted-foreground" />
				<span class="text-xs font-medium text-muted-foreground">Lyrics</span>
				<Show when={kind()}>
					{(currentKind) => (
						<span
							class="animate-in fade-in rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
							title={KIND_TITLES[currentKind()]}
						>
							{LYRICS_KIND_LABELS[currentKind()]}
						</span>
					)}
				</Show>
				<Show when={activeUnconfirmed()}>
					<span
						class="animate-in fade-in rounded-full bg-foreground/6 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
						title="Matched by title alone — may be a different version of this song"
					>
						Loose match
					</span>
				</Show>
				<Show when={available().length >= 2}>
					<div class="ml-auto flex items-center gap-0.5 rounded-full bg-foreground/6 p-0.5">
						<For each={available()}>
							{(provider) => (
								<button
									class={cn(
										"animate-in fade-in rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-150",
										view() === provider.id
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
									onClick={() => {
										manualView = true;
										setView(provider.id);
									}}
									type="button"
								>
									{provider.label}
								</button>
							)}
						</For>
					</div>
				</Show>
			</div>
			<Show when={!active() && pending()}>
				<LyricsSkeleton />
			</Show>
			<Show when={activeSynced()}>
				{(lines) => (
					<SyncedLines
						attribution={attribution()}
						currentTime={props.currentTime}
						lines={lines()}
						onSeekTime={props.onSeekTime}
						romanize={settings.romanizeLyrics}
						videoRef={props.videoRef}
					/>
				)}
			</Show>
			<Show when={activePlain()}>
				{(text) => (
					<LyricsLines
						attribution={attribution()}
						romanize={settings.romanizeLyrics}
						text={text()}
					/>
				)}
			</Show>
			<Show when={!pending() && available().length === 0}>
				<LyricsFallback />
			</Show>
		</div>
	);
}

function SyncedLines(props: {
	lines: LrcLine[];
	currentTime: number;
	onSeekTime: (seconds: number) => void;
	romanize: boolean;
	attribution?: string;
	videoRef?: VideoRef | null;
}) {
	let container!: HTMLDivElement;
	// Visual anchor per line index: the line itself, or the dots row that
	// replaces it during silence
	const anchors: Array<HTMLElement | null> = [];
	// Pauses auto-scroll briefly while the user scrolls manually
	let holdUntil = 0;
	const lineTexts = () => props.lines.map((line) => line.text);
	const romanized = useRomanizedLines(lineTexts, () => props.romanize);
	// Romaji spacing stays reserved while pending; dropped once there is
	// nothing to show (Latin-script lyrics, or every reading matches).
	const showRomaji = () => props.romanize && romanized()?.size !== 0;

	const activeIndex = createMemo(() => {
		let idx = -1;
		for (let i = 0; i < props.lines.length; i++) {
			if (props.lines[i].time <= props.currentTime + 0.25) {
				idx = i;
			} else {
				break;
			}
		}
		return idx;
	});

	// Build render segments: runs of silence-only lines ("♪"/empty) are
	// replaced by a single dots row; everything else renders as-is.
	const segments = createMemo(() => {
		const lines = props.lines;
		const out: Array<
			| { kind: "line"; index: number }
			| {
					kind: "dots";
					from: number;
					to: number;
					start: number;
					end: number | null;
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
				});
			} else {
				out.push({ kind: "line", index: i });
				i++;
			}
		}
		return out;
	});

	// Auto-scroll is animated by hand rather than with `behavior: "smooth"`:
	// Chromium on Windows (WebView2) drops smooth programmatic scrolling
	// whenever the OS animation/smooth-scroll setting is off, so the lyrics
	// jumped line to line on desktop while Android eased them.
	let scrollFrame = 0;
	const stopScroll = () => {
		cancelAnimationFrame(scrollFrame);
		scrollFrame = 0;
	};
	onCleanup(stopScroll);

	createEffect(
		() => activeIndex(),
		(idx) => {
			if (!container) return;
			// Center the first line before playback reaches its timestamp too
			const target = idx < 0 ? 0 : idx;
			const el = anchors[target];
			if (!el) return;
			if (Date.now() < holdUntil) return;
			const max = container.scrollHeight - container.clientHeight;
			const to = Math.min(
				max,
				Math.max(
					0,
					el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2,
				),
			);
			stopScroll();
			const from = container.scrollTop;
			const distance = to - from;
			if (Math.abs(distance) < 1) return;
			// Long jumps (seeks, first load) get a bit more time, capped.
			const duration = Math.min(900, 450 + Math.abs(distance) * 0.25);
			const start = performance.now();
			const tick = (now: number) => {
				const t = Math.min((now - start) / duration, 1);
				// easeInOutCubic: settles like the browser's smooth scroll
				const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
				container.scrollTop = from + distance * eased;
				scrollFrame = t < 1 ? requestAnimationFrame(tick) : 0;
			};
			scrollFrame = requestAnimationFrame(tick);
		},
	);

	// Manual scrolling wins: stop any running glide and pause auto-scroll.
	const hold = () => {
		stopScroll();
		holdUntil = Date.now() + 4000;
	};

	const setAnchor = (index: number, el: HTMLParagraphElement | null) => {
		anchors[index] = el;
	};

	return (
		<div
			class="no-scrollbar fade-mask-y relative min-h-0 flex-1 overflow-y-auto pr-2"
			data-swipe-dismiss-ignore
			onTouchMove={hold}
			onWheel={hold}
			ref={container}
		>
			{/* Half-viewport spacers so the first and last lines can truly center */}
			<div class="pb-[50vh] pt-[50vh]">
				<For each={segments()}>
					{(seg) => {
						if (seg.kind === "dots") {
							// Only render while the silence is actually happening
							const visible = () =>
								props.currentTime >= seg.start &&
								(seg.end === null || props.currentTime < seg.end);
							const progress = () =>
								seg.end === null
									? 0
									: Math.min(
											1,
											Math.max(
												0,
												(props.currentTime - seg.start) / (seg.end - seg.start),
											),
										);
							return (
								<Show when={visible()}>
									<div
										ref={(el) => {
											for (let k = seg.from; k <= seg.to; k++) {
												anchors[k] = el;
											}
										}}
									>
										<PauseDots
											looping={seg.end === null}
											progress={progress()}
										/>
									</div>
								</Show>
							);
						}
						const line = () => props.lines[seg.index];
						const lineWords = () => line().words ?? [];
						const isActive = () => seg.index === activeIndex();
						return (
							<Show
								fallback={
									<LyricLine
										index={seg.index}
										isActive={isActive()}
										onRef={setAnchor}
										onSeekTime={props.onSeekTime}
										romanize={showRomaji()}
										romanizedText={romanized()?.get(seg.index)}
										text={line().text}
										time={line().time}
									/>
								}
								when={lineWords().length > 0}
							>
								<WordSyncLyricLine
									activeTime={isActive() ? props.currentTime : undefined}
									endTime={props.lines[seg.index + 1]?.time}
									index={seg.index}
									isActive={isActive()}
									onRef={setAnchor}
									onSeekTime={props.onSeekTime}
									romanize={showRomaji()}
									romanizedText={romanized()?.get(seg.index)}
									time={line().time}
									videoRef={props.videoRef}
									words={lineWords()}
								/>
							</Show>
						);
					}}
				</For>
				<Show when={props.attribution}>
					{(source) => <LyricsAttribution source={source()} />}
				</Show>
			</div>
		</div>
	);
}

/**
 * One lyric line. Only the line whose active state changed re-renders on a
 * clock tick; the others keep their DOM.
 */
function LyricLine(props: {
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
			class={cn(
				"cursor-pointer text-[26px] leading-snug font-medium tracking-tight transition-colors duration-500 py-3",
				props.isActive
					? "text-foreground [text-shadow:0_0_24px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
					: "text-foreground/25 hover:text-foreground/60",
			)}
			onClick={() => props.onSeekTime(props.time)}
			ref={(el) => props.onRef(props.index, el)}
		>
			<Show fallback={props.text} when={props.isActive && props.text}>
				<For each={Array.from(props.text)}>
					{(char, charIndex) => (
						// Plain spaces stay outside the spans so line breaks still
						// happen at word boundaries, and inline spans keep font
						// shaping (kerning, CJK punctuation) intact.
						<Show fallback={" "} when={char !== " "}>
							<span
								class="relative inline animate-char-wave"
								style={{ "animation-delay": `${charIndex() * 30}ms` }}
							>
								{char}
							</span>
						</Show>
					)}
				</For>
			</Show>
			<Show when={props.romanize && props.romanizedText}>
				{(reading) => (
					<span class="mt-1 block text-sm leading-normal font-normal text-foreground/45">
						{reading()}
					</span>
				)}
			</Show>
		</p>
	);
}

/**
 * The word line's playback position at display rate. The panel's
 * `currentTime` prop only updates on `timeupdate` (~4Hz), which steps the
 * fill; while the line is active the media element is sampled once per
 * animation frame instead, so re-renders stay inside the line component.
 * Returns undefined while the line is inactive (all words stay dim).
 */
function useLivePosition(
	videoRef: VideoRef | null | undefined,
	activeTime: () => number | undefined,
): () => number | undefined {
	const [position, setPosition] = createSignal(0);

	createEffect(
		() => ({
			active: activeTime() !== undefined,
			// Snapshot the element in the compute phase: reading the (reactive)
			// prop accessor inside the effect callback would be untracked.
			element: videoRef?.current ?? null,
		}),
		({ active, element }) => {
			if (!active || !videoRef) return;
			if (element) setPosition(element.currentTime);
			let frame = requestAnimationFrame(function tick() {
				const media = videoRef.current;
				if (media) setPosition(media.currentTime);
				frame = requestAnimationFrame(tick);
			});
			return () => cancelAnimationFrame(frame);
		},
	);

	// Without a media element, fall back to the prop clock.
	return () =>
		activeTime() === undefined
			? undefined
			: videoRef
				? position()
				: activeTime();
}

/** Last-resort fill window for a word with no end and no following word. */
const WORD_TAIL_SEC = 0.6;

/** Karaoke fill of a span: lit up to `progress`, with a glow on the fill. */
function fillStyle(progress: number, dim: number): JSX.CSSProperties {
	return {
		"background-image": `linear-gradient(to right, var(--foreground) ${
			progress * 100
		}%, color-mix(in oklab, var(--foreground) ${dim}%, transparent) ${
			progress * 100
		}%)`,
		"background-clip": "text",
		"-webkit-background-clip": "text",
		color: "transparent",
		"-webkit-text-fill-color": "transparent",
		filter:
			"drop-shadow(0 0 12px color-mix(in oklab, var(--primary) 35%, transparent))",
	};
}

/**
 * A word-synced lyric line: every word fills with the highlight from left to
 * right while it is being sung (start → end time), upcoming words stay dim,
 * finished words are lit — and the romanized reading below fills along with
 * it. Only the active line receives a live position, so the other (often
 * many) word lines keep their rendering and don't re-render on every clock
 * tick.
 */
function WordSyncLyricLine(props: {
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
	videoRef?: VideoRef | null;
}) {
	const position = useLivePosition(props.videoRef, () => props.activeTime);

	// A word without an end lasts until the next one starts — the line's end
	// for the final word, or a short tail when even that is unknown.
	const ends = () =>
		props.words.map(
			(word, wi) =>
				word.end ??
				props.words[wi + 1]?.time ??
				props.endTime ??
				word.time + WORD_TAIL_SEC,
		);

	// The reading fills with the same timing, weighted by each chunk's text
	// length: the fraction of the romaji that is sung at the current position.
	const readingProgress = () => {
		const at = position();
		if (at === undefined) return 0;
		const words = props.words;
		const total = words.reduce((sum, word) => sum + word.text.trim().length, 0);
		if (total <= 0) return 0;
		const wordEnds = ends();
		let sung = 0;
		for (let i = 0; i < words.length; i++) {
			sung +=
				wordProgress(words[i].time, wordEnds[i], at) *
				words[i].text.trim().length;
		}
		return sung / total;
	};

	return (
		<p
			class={cn(
				"cursor-pointer py-3 text-[26px] leading-snug font-medium tracking-tight transition-colors duration-500",
				!props.isActive && "text-foreground/25 hover:text-foreground/60",
			)}
			onClick={() => props.onSeekTime(props.time)}
			ref={(el) => props.onRef(props.index, el)}
		>
			<For each={props.words}>
				{(word, wi) => {
					const progress = () => {
						const at = position();
						return at === undefined
							? 0
							: wordProgress(word.time, ends()[wi()], at);
					};
					return (
						<span
							class={cn(
								"relative inline",
								progress() <= 0 && "text-foreground/25",
							)}
							onClick={(event) => {
								event.stopPropagation();
								props.onSeekTime(word.time);
							}}
							style={progress() > 0 ? fillStyle(progress(), 25) : undefined}
						>
							{word.text}
						</span>
					);
				}}
			</For>
			<Show when={props.romanize && props.romanizedText}>
				{(reading) => (
					<span class="mt-1 block text-sm leading-normal font-normal text-foreground/45">
						<Show fallback={reading()} when={position() !== undefined}>
							<For
								each={readingSegments(reading(), readingProgress())}
								keyed={(segment) => segment.start}
							>
								{(segment) => (
									<Show
										fallback={segment().text}
										when={segment().sung !== undefined}
									>
										<span
											class="relative inline"
											style={
												(segment().sung ?? 0) > 0
													? fillStyle(segment().sung ?? 0, 45)
													: undefined
											}
										>
											{segment().text}
										</span>
									</Show>
								)}
							</For>
						</Show>
					</span>
				)}
			</Show>
		</p>
	);
}

function LyricsLines(props: {
	text: string;
	romanize: boolean;
	attribution?: string;
}) {
	const lines = createMemo(() => props.text.split("\n"));
	const romanized = useRomanizedLines(lines, () => props.romanize);
	const showRomaji = () => props.romanize && romanized()?.size !== 0;

	return (
		<div
			class="no-scrollbar fade-mask-y relative min-h-0 flex-1 overflow-y-auto pr-2"
			data-swipe-dismiss-ignore
		>
			<div class="pb-24 pt-10">
				<For each={lines()}>
					{(line, i) => (
						<Show fallback={<div class="h-5" />} when={line.trim() !== ""}>
							<p
								class={cn(
									"cursor-default text-[26px] leading-snug font-medium tracking-tight text-foreground/25 transition-colors duration-200 hover:text-foreground",
									showRomaji() ? "py-3" : "py-2.5",
									i() === 0 && "text-foreground/70",
								)}
							>
								{line}
								<Show when={showRomaji() && romanized()?.get(i())}>
									{(reading) => (
										<span class="mt-1 block text-base leading-normal font-normal text-foreground/45">
											{reading()}
										</span>
									)}
								</Show>
							</p>
						</Show>
					)}
				</For>
				<Show when={props.attribution}>
					{(source) => <LyricsAttribution source={source()} />}
				</Show>
			</div>
		</div>
	);
}

function LyricsAttribution(props: { source: string }) {
	return (
		<p class="mt-8 text-[11px] text-muted-foreground/50">
			Lyrics via {props.source}
		</p>
	);
}

function LyricsSkeleton() {
	return (
		<div class="flex min-h-0 flex-1 flex-col gap-4 pr-2">
			<For each={[85, 65, 92, 58, 78, 88, 45, 70, 60]}>
				{(width, i) => (
					<div
						class="shimmer-surface h-6 rounded-md"
						style={{
							width: `${width}%`,
							"animation-delay": `${i() * 120}ms`,
						}}
					/>
				)}
			</For>
		</div>
	);
}

function LyricsFallback() {
	return (
		<div class="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
			<AudioLines class="mb-4 size-8 text-muted-foreground/60" />
			<p class="text-sm font-medium text-muted-foreground/60">
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
function PauseDots(props: { progress: number; looping: boolean }) {
	return (
		<span aria-hidden="true" class="flex items-center gap-1.5 py-2.5 pl-1">
			<For each={[0, 1, 2]}>
				{(dot) => {
					const filled = () =>
						!props.looping && props.progress >= (dot + 0.5) / 3;
					return (
						<span
							class={cn(
								"size-2 rounded-full bg-white/25",
								filled() && "bg-white shadow-[0_0_8px_rgba(255,255,255,0.45)]",
								props.looping ? "animate-dot-fill" : "animate-dot-wave",
							)}
							style={{
								"animation-delay": `${dot * (props.looping ? 0.35 : 0.18)}s`,
							}}
						/>
					);
				}}
			</For>
		</span>
	);
}

/** Detects silence-only LRC lines ("♪", empty, etc.). */
function isSilentLine(text: string): boolean {
	const s = text.trim();
	return s === "" || /^[♪♫*●○]+$/u.test(s);
}
