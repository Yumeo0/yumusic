import {
	ArrowUpRight,
	ChevronDown,
	ChevronUp,
	Disc3,
	ListMusic,
	ListPlus,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { PlaylistContextMenu } from "@/components/playlist/playlist-menu";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { usePinnedPlaylists } from "@/lib/stores/pinned";
import { useSettings } from "@/lib/stores/settings";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { useMediaQuery } from "@/lib/utils/hooks";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import { cn } from "@/lib/utils/utils";
import { type FeedItem, toFeedItem } from "@/lib/youtube/feed-items";
import {
	enrichSongsWithDescriptions,
	enrichSongsWithUploads,
} from "@/lib/youtube/song-description";
import { getYoutubeClient } from "@/lib/youtube/youtube-client";

interface FeedSection {
	title: string;
	items: FeedItem[];
}

/** Matches Tailwind's `md` breakpoint; below it the feed uses compact rows. */
const MOBILE_QUERY = "(max-width: 767.98px)";
/** Devices with a touchscreen — the only ones that can swipe rows. */
const TOUCH_QUERY = "(any-pointer: coarse)";
/** Rows per home section on phones before "Show more". */
const MOBILE_SECTION_PREVIEW = 5;
const SWIPE_HINT_KEY = "yumusic:swipe-queue-hint";

/** Home sections the user can hide (normalized titles, see below). */
const HIDDEN_SECTION_TITLES = new Set(["today's biggest hits"]);

function isHiddenSectionTitle(title: string): boolean {
	const normalized = title
		.trim()
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'");
	return HIDDEN_SECTION_TITLES.has(normalized);
}

function FeedCard({ item, onClick }: { item: FeedItem; onClick: () => void }) {
	const isArtist = item.kind === "artist";
	const title =
		item.kind === "song"
			? item.song.title
			: item.kind === "artist"
				? formatArtistName(item.name)
				: item.title;
	const subtitle = item.kind === "song" ? item.song.artist : item.subtitle;
	const thumbnail = item.kind === "song" ? item.song.thumbnail : item.thumbnail;

	return (
		<button
			className={cn(
				"group w-32 shrink-0 text-left md:w-44",
				isArtist && "text-center",
			)}
			onClick={onClick}
			type="button"
		>
			<div
				className={cn(
					"relative aspect-square overflow-hidden border border-foreground/8 bg-card",
					isArtist ? "rounded-full" : "rounded-xl",
				)}
			>
				{thumbnail && (
					<img
						alt={title}
						className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
						loading="lazy"
						src={proxiedImageUrl(thumbnail)}
					/>
				)}
				{(item.kind === "playlist" || item.kind === "album") && (
					<span className="pointer-events-none absolute bottom-2 left-2 grid size-7 place-items-center rounded-md bg-black/60 text-white shadow-sm backdrop-blur-xs">
						{item.kind === "playlist" ? (
							<ListMusic className="size-4" />
						) : (
							<Disc3 className="size-4" />
						)}
					</span>
				)}
				{item.kind === "song" ? (
					<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
						<svg
							aria-hidden
							className="size-4 translate-x-px fill-current"
							viewBox="0 0 24 24"
						>
							<path d="M8 5.14v13.72c0 1.23 1.34 1.98 2.39 1.36l11.02-6.86a1.6 1.6 0 0 0 0-2.72L10.39 3.78C9.34 3.16 8 3.91 8 5.14Z" />
						</svg>
					</span>
				) : (
					<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
						<ArrowUpRight className="size-4" />
					</span>
				)}
			</div>
			<h3 className="mt-2.5 flex items-center gap-1.5 text-sm font-medium transition-colors group-hover:text-primary">
				<span className="line-clamp-1 min-w-0">
					{item.kind === "song" ? (
						<SongTitle
							artist={item.song.artist}
							keepTitle={item.song.upload}
							title={item.song.title}
						/>
					) : (
						title
					)}
				</span>
				{item.kind === "song" && <DownloadedBadge songId={item.song.id} />}
			</h3>
			<p
				className={cn(
					"mt-0.5 line-clamp-1 text-xs text-muted-foreground",
					isArtist && "text-center",
				)}
			>
				{item.kind === "song" ? <ArtistLinks song={item.song} /> : subtitle}
			</p>
		</button>
	);
}

/**
 * Compact mobile row: the same feed entry as a card, laid out for a vertical
 * list. On touch devices song rows carry a persistent queue hint so the swipe
 * gesture is discoverable; the queue action itself lives in the SwipeToQueue
 * wrapper.
 */
function FeedRow({
	item,
	isCurrent = false,
	swipeEnabled = false,
	onClick,
}: {
	item: FeedItem;
	isCurrent?: boolean;
	swipeEnabled?: boolean;
	onClick: () => void;
}) {
	const isArtist = item.kind === "artist";
	const title =
		item.kind === "song"
			? item.song.title
			: item.kind === "artist"
				? formatArtistName(item.name)
				: item.title;
	const thumbnail = item.kind === "song" ? item.song.thumbnail : item.thumbnail;

	return (
		<button
			className={cn(
				"group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 active:bg-foreground/5",
				isCurrent && "bg-primary/8",
			)}
			onClick={onClick}
			type="button"
		>
			<span className="relative shrink-0">
				{thumbnail ? (
					<img
						alt={title}
						className={cn(
							"size-10 border border-foreground/10 object-cover",
							isArtist ? "rounded-full" : "rounded-md",
						)}
						loading="lazy"
						src={proxiedImageUrl(thumbnail)}
					/>
				) : (
					<span
						className={cn(
							"block size-10 bg-muted",
							isArtist ? "rounded-full" : "rounded-md",
						)}
					/>
				)}
				{(item.kind === "playlist" || item.kind === "album") && (
					<span className="absolute -right-1 -bottom-1 grid size-4.5 place-items-center rounded bg-background/90 text-muted-foreground shadow-sm">
						{item.kind === "playlist" ? (
							<ListMusic className="size-3" />
						) : (
							<Disc3 className="size-3" />
						)}
					</span>
				)}
			</span>
			<span className="min-w-0 flex-1">
				<span
					className={cn(
						"block truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary",
						isCurrent && "text-primary",
					)}
				>
					{item.kind === "song" ? (
						<SongTitle
							artist={item.song.artist}
							keepTitle={item.song.upload}
							title={item.song.title}
						/>
					) : (
						title
					)}
				</span>
				<span className="mt-0.5 block truncate text-xs text-muted-foreground">
					{item.kind === "song" ? (
						<ArtistLinks song={item.song} />
					) : (
						item.subtitle
					)}
				</span>
			</span>
			<span className="flex shrink-0 items-center gap-2 text-muted-foreground/60">
				{item.kind === "song" && <DownloadedBadge songId={item.song.id} />}
				{item.kind === "song" && item.song.duration && (
					<span className="font-mono text-[11px] tabular-nums">
						{item.song.duration}
					</span>
				)}
				{item.kind === "song" && swipeEnabled && (
					<ListPlus aria-hidden className="size-4" />
				)}
				{item.kind !== "song" && (
					<ArrowUpRight aria-hidden className="size-4" />
				)}
			</span>
		</button>
	);
}

/** One-time mobile tip explaining the swipe gesture. */
function SwipeQueueHint({ onDismiss }: { onDismiss: () => void }) {
	return (
		<div className="mb-2 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/6 px-3 py-2 text-xs text-muted-foreground">
			<ListPlus className="size-4 shrink-0 text-primary" />
			<span className="flex-1">Swipe a song right to add it to the queue.</span>
			<button
				aria-label="Dismiss swipe tip"
				className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:bg-foreground/8 hover:text-foreground"
				onClick={onDismiss}
				type="button"
			>
				<X className="size-3.5" />
			</button>
		</div>
	);
}

function swipeHintDismissed(): boolean {
	try {
		return localStorage.getItem(SWIPE_HINT_KEY) === "dismissed";
	} catch {
		return true;
	}
}

/** Every playable song in the feed, for the description prefetch. */
function feedSongs(sections: FeedSection[]): Song[] {
	return sections.flatMap((section) =>
		section.items.flatMap((item) => (item.kind === "song" ? [item.song] : [])),
	);
}

/** Replaces one song wherever it appears in the feed. */
function withUpdatedSong(
	sections: FeedSection[],
	updated: Song,
): FeedSection[] {
	return sections.map((section) => ({
		...section,
		items: section.items.map((item) =>
			item.kind === "song" && item.song.id === updated.id
				? { ...item, song: updated }
				: item,
		),
	}));
}

/**
 * Recommended tracks, playlists, albums and artists from the YouTube Music
 * home feed. Desktop keeps the horizontally scrollable card shelves; phones
 * get compact rows so songs can use the swipe-to-queue gesture without
 * fighting a horizontal scroller. Renders nothing while signed out.
 */
export function HomeFeed() {
	const { play, addToQueue, currentSong, queue } = usePlayer();
	const navigate = useNavigate();
	const [settings] = useSettings();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const isMobile = useMediaQuery(MOBILE_QUERY);
	const hasTouch = useMediaQuery(TOUCH_QUERY);
	// Only touch devices can perform the swipe; a narrow desktop window gets
	// the compact rows without the gesture hint or affordance.
	const swipeEnabled = isMobile && hasTouch;
	const [sections, setSections] = useState<FeedSection[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [expandedSections, setExpandedSections] = useState<Set<string>>(
		() => new Set(),
	);
	const [swipeHint, setSwipeHint] = useState(() => !swipeHintDismissed());
	// Description prefetch: uploader descriptions carry the real song credits
	// ("Singer: X / Song: Y") and resolve the ambiguous titles the raw
	// pipeline leaves alone. Rows update as each description lands.
	const enrichCancelRef = useRef<(() => void) | null>(null);
	const uploadCancelRef = useRef<(() => void) | null>(null);
	// Read at prefetch start; whatever is playing gets its description from
	// the player response, so fetching it here would be a duplicate request.
	const playingIdRef = useRef(currentSong?.id);
	playingIdRef.current = currentSong?.id;
	// Video cards already resolved to their song version while playing.
	const versions = useSongVersionReplacements();

	const removeFeedItem = (id: string) =>
		setSections((prev) =>
			prev
				? prev.map((section) => ({
						...section,
						items: section.items.filter(
							(entry) =>
								entry.kind === "song" ||
								entry.kind === "artist" ||
								entry.id !== id,
						),
					}))
				: prev,
		);

	const dismissSwipeHint = () => {
		setSwipeHint(false);
		try {
			localStorage.setItem(SWIPE_HINT_KEY, "dismissed");
		} catch {
			// best-effort
		}
	};

	const toggleSection = (key: string) => {
		setExpandedSections((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	/**
	 * Swipe action for a home row. Mirrors the context menu: with nothing
	 * playing or queued there is no queue to append to, so the song starts.
	 */
	const queueSong = (song: Song) => {
		dismissSwipeHint();
		if (!currentSong && queue.length === 0) {
			play(song);
			return;
		}
		addToQueue([song]);
		showToast("Added to queue");
	};

	/** Plays a row and queues the rest of its section behind it. */
	const playFromSection = (section: FeedSection, index: number, song: Song) => {
		const rest = section.items
			.slice(index + 1)
			.flatMap((next) => (next.kind === "song" ? [next.song] : []));
		play(song, rest);
	};

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const client = await getYoutubeClient();
				const feed = await client.music.getHomeFeed();

				const out: FeedSection[] = [];
				for (const section of feed.sections ?? []) {
					if (!section.is(YTNodes.MusicCarouselShelf)) continue;
					const title = section.header?.title?.text || "";
					const items: FeedItem[] = [];
					for (const item of section.contents ?? []) {
						if (
							!item.is(YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem)
						) {
							continue;
						}
						const feedItem = toFeedItem(item);
						if (feedItem) items.push(feedItem);
					}
					if (items.length > 0) {
						out.push({ title, items });
					}
				}

				if (cancelled) return;
				setSections(out);
				setFailed(out.length === 0);
				const playingId = playingIdRef.current;
				const applyUpdatedSong = (updated: Song): void => {
					setSections((prev) => (prev ? withUpdatedSong(prev, updated) : prev));
				};
				enrichCancelRef.current = enrichSongsWithDescriptions(
					feedSongs(out),
					applyUpdatedSong,
					playingId ? new Set([playingId]) : undefined,
				);
				// Reuploads (no release) keep their raw titles; the player
				// marks what it plays, this covers the rest of the feed.
				uploadCancelRef.current = enrichSongsWithUploads(
					feedSongs(out),
					applyUpdatedSong,
				);
			} catch (error) {
				console.warn("[HomeFeed] failed to load recommendations:", error);
				if (cancelled) return;
				setSections([]);
				setFailed(true);
			}
		})();
		return () => {
			cancelled = true;
			enrichCancelRef.current?.();
			uploadCancelRef.current?.();
		};
	}, []);

	if (sections === null) {
		if (isMobile) {
			return (
				<div className="space-y-10">
					{[0, 1].map((row) => (
						<div key={`feed-skeleton-${row}`}>
							<div className="shimmer-surface mb-3 h-4 w-40 rounded-md" />
							<div className="space-y-1">
								{Array.from({ length: MOBILE_SECTION_PREVIEW }, (_, i) => (
									<div
										className="flex items-center gap-3 px-2.5 py-2"
										// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
										key={`s-${row}-${i}`}
									>
										<div className="shimmer-surface size-10 shrink-0 rounded-md" />
										<div className="min-w-0 flex-1 space-y-1.5">
											<div className="shimmer-surface h-3.5 w-2/5 rounded" />
											<div className="shimmer-surface h-2.5 w-1/4 rounded" />
										</div>
									</div>
								))}
							</div>
						</div>
					))}
				</div>
			);
		}
		return (
			<div className="space-y-10">
				{[0, 1].map((row) => (
					<div key={`feed-skeleton-${row}`}>
						<div className="shimmer-surface mb-4 h-4 w-40 rounded-md" />
						<div className="flex gap-4">
							{Array.from({ length: 5 }, (_, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
									key={`s-${row}-${i}`}
								>
									<div className="shimmer-surface aspect-square w-32 rounded-xl md:w-44" />
									<div className="shimmer-surface mt-2.5 h-4 w-24 rounded-md md:w-32" />
									<div className="shimmer-surface mt-2 h-3 w-16 rounded-md md:w-24" />
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		);
	}

	if (failed) {
		return (
			<p className="text-sm text-muted-foreground/70">
				Recommendations unavailable — log in to see your mix.
			</p>
		);
	}

	const visibleSections = sections.filter(
		(section) =>
			!(settings.hideTodaysBiggestHits && isHiddenSectionTitle(section.title)),
	);
	const firstSongSection = visibleSections.findIndex((section) =>
		section.items.some((item) => item.kind === "song"),
	);

	return (
		<div>
			{visibleSections.map((section, si) => {
				const sectionKey = `feed-section-${si}`;
				const expanded = expandedSections.has(sectionKey);
				const shownItems =
					isMobile && !expanded
						? section.items.slice(0, MOBILE_SECTION_PREVIEW)
						: section.items;
				const showHint = swipeEnabled && si === firstSongSection && swipeHint;

				return (
					<section
						className="animate-track-in pb-3"
						// biome-ignore lint/suspicious/noArrayIndexKey: home feed sections may repeat titles
						key={`feed-${section.title}-${si}`}
						style={{ animationDelay: `${si * 80}ms` }}
					>
						<div className="mb-4 flex items-center gap-2">
							<h2 className="text-sm font-medium text-muted-foreground">
								{section.title}
							</h2>
							<span className="h-px flex-1 bg-linear-to-r from-border to-transparent" />
						</div>
						{isMobile ? (
							<div className="space-y-0.5">
								{showHint && <SwipeQueueHint onDismiss={dismissSwipeHint} />}
								{shownItems.map((item, i) => {
									// A video resolved to its album track while playing
									// is shown and played as that song.
									const song =
										item.kind === "song"
											? (versions.get(item.song.id) ?? item.song)
											: null;
									const onOpen =
										item.kind === "song"
											? () => playFromSection(section, i, song ?? item.song)
											: item.kind === "artist"
												? () => navigate(`/artist/${item.id}`)
												: () => navigate(`/playlists/${item.id}`);
									const key = `${item.kind}-${item.kind === "song" ? item.song.id : item.id}-${i}`;
									if (item.kind === "song") {
										const row = (
											<FeedRow
												isCurrent={currentSong?.id === (song ?? item.song).id}
												item={{
													...item,
													song: song ?? item.song,
												}}
												onClick={onOpen}
												swipeEnabled={swipeEnabled}
											/>
										);
										return (
											<SongContextMenu key={key} song={song ?? item.song}>
												{swipeEnabled ? (
													<SwipeToQueue
														onQueue={() => queueSong(song ?? item.song)}
													>
														{row}
													</SwipeToQueue>
												) : (
													row
												)}
											</SongContextMenu>
										);
									}
									if (item.kind === "playlist" || item.kind === "album") {
										return (
											<PlaylistContextMenu
												isPinned={isPinned(item.id)}
												key={key}
												onDeleted={() => removeFeedItem(item.id)}
												onTogglePinned={() =>
													togglePinned({
														id: item.id,
														thumbnail: item.thumbnail,
														title: item.title,
													})
												}
												playlist={item}
											>
												<FeedRow item={item} onClick={onOpen} />
											</PlaylistContextMenu>
										);
									}
									return <FeedRow item={item} key={key} onClick={onOpen} />;
								})}
								{section.items.length > MOBILE_SECTION_PREVIEW && (
									<button
										aria-expanded={expanded}
										className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground"
										onClick={() => toggleSection(sectionKey)}
										type="button"
									>
										{expanded ? (
											<ChevronUp className="size-3.5" />
										) : (
											<ChevronDown className="size-3.5" />
										)}
										{expanded ? "Show less" : "Show more"}
									</button>
								)}
							</div>
						) : (
							<div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
								{section.items.map((item, i) => {
									// A video resolved to its album track while playing
									// is shown and played as that song.
									const song =
										item.kind === "song"
											? (versions.get(item.song.id) ?? item.song)
											: null;
									const onOpen =
										item.kind === "song"
											? () => playFromSection(section, i, song ?? item.song)
											: item.kind === "artist"
												? () => navigate(`/artist/${item.id}`)
												: () => navigate(`/playlists/${item.id}`);
									const key = `${item.kind}-${item.kind === "song" ? item.song.id : item.id}-${i}`;
									if (item.kind === "song") {
										return (
											<SongContextMenu key={key} song={song ?? item.song}>
												<FeedCard
													item={{ ...item, song: song ?? item.song }}
													onClick={onOpen}
												/>
											</SongContextMenu>
										);
									}
									if (item.kind === "playlist" || item.kind === "album") {
										return (
											<PlaylistContextMenu
												isPinned={isPinned(item.id)}
												key={key}
												onDeleted={() => removeFeedItem(item.id)}
												onTogglePinned={() =>
													togglePinned({
														id: item.id,
														thumbnail: item.thumbnail,
														title: item.title,
													})
												}
												playlist={item}
											>
												<FeedCard item={item} onClick={onOpen} />
											</PlaylistContextMenu>
										);
									}
									return <FeedCard item={item} key={key} onClick={onOpen} />;
								})}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}
