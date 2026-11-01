import { AudioLines, ChevronRight, Loader2, Shuffle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type Types, type YTMusic, YTNodes } from "youtubei.js/web";
import { EqualizerBars } from "@/components/player/waveform";
import { PlaylistContextMenu } from "@/components/playlist/playlist-menu";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { ArtistContextMenu } from "@/components/song/artist-menu";
import { CoverImage } from "@/components/song/cover-image";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { usePinnedPlaylists } from "@/lib/stores/pinned";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import { biggestThumb, cn, hiResThumb } from "@/lib/utils/utils";
import { channelSearchEntries } from "@/lib/youtube/channel-data";
import {
	artistListOf,
	isVideoId,
	videoIdOf,
} from "../../lib/youtube/youtube.utils";
import {
	getArtistMixSongs,
	getTrackDurations,
	getYoutubeClient,
} from "../../lib/youtube/youtube-client";

interface SearchResultsPageProps {
	query: string;
}

type SearchTab = "all" | "music" | "channel" | "video" | "playlist" | "album";

/** One rendered search result. Rows the app cannot open (podcasts, profiles) are dropped. */
type PlayableEntry = { kind: "playable"; song: Song };
type ArtistEntry = {
	kind: "artist";
	id: string;
	name: string;
	subtitle: string;
	thumbnail: string;
};
type CollectionEntry = {
	kind: "collection";
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string;
};
type SearchEntry = (PlayableEntry | ArtistEntry | CollectionEntry) & {
	/** The search's top-result card, rendered as the bigger card above the list. */
	top?: boolean;
	/** Top-result card: the associated tracks, rendered inside the card. */
	songs?: Song[];
};

/** What the active tab shows: a skeleton, an error, or the fetched rows. */
type TabView =
	| { status: "loading" }
	| { status: "error" }
	| { status: "ready"; entries: SearchEntry[] };

const TABS: Array<{
	id: SearchTab;
	label: string;
	type?: Types.MusicSearchType;
}> = [
	{ id: "all", label: "All" },
	{ id: "music", label: "Music", type: "song" },
	{ id: "channel", label: "Channel" },
	{ id: "video", label: "Video", type: "video" },
	{ id: "playlist", label: "Playlists", type: "playlist" },
	{ id: "album", label: "Albums", type: "album" },
];

type SearchSection =
	| YTNodes.MusicShelf
	| YTNodes.MusicCardShelf
	| YTNodes.ItemSection;

/**
 * The artist a top-result card stands for, when it is an artist page. Rows
 * inside such a card omit the artist credit (the card itself is the artist),
 * so they need it as a fallback to avoid showing "Unknown Artist".
 */
function cardArtist(
	section: SearchSection,
): { name: string; id: string } | null {
	if (!section.is(YTNodes.MusicCardShelf)) return null;
	const payload = section.on_tap?.payload;
	const cardPageType =
		payload?.browseEndpointContextSupportedConfigs
			?.browseEndpointContextMusicConfig?.pageType;
	if (cardPageType !== "MUSIC_PAGE_TYPE_ARTIST") return null;
	const id = payload?.browseId as string | undefined;
	const name = section.title?.toString().trim();
	if (!id?.startsWith("UC") || !name) return null;
	return { name, id };
}

/** Whether parsed credits name a real artist, not the unknown placeholder. */
function hasArtistCredit(artists: Array<{ name: string }>): boolean {
	return artists.some((artist) => {
		const name = artist.name?.trim();
		return !!name && !/^unknown artist$/i.test(name);
	});
}

/** Dedupe key of an entry: an entity can appear in several search layouts. */
function entryKey(entry: SearchEntry): string {
	if (entry.kind === "playable") return `playable:${entry.song.id}`;
	if (entry.kind === "artist") return `artist:${entry.id}`;
	return `collection:${entry.id}`;
}

/** Shows and plays resolved video entries as their song version. */
function withSongVersions(
	entry: SearchEntry,
	versions: ReadonlyMap<string, Song>,
): SearchEntry {
	const song =
		entry.kind === "playable"
			? (versions.get(entry.song.id) ?? entry.song)
			: undefined;
	const songs = entry.songs?.map((item) => versions.get(item.id) ?? item);
	if (!song && !songs) return entry;
	return {
		...entry,
		...(song ? { song } : {}),
		...(songs ? { songs } : {}),
	} as SearchEntry;
}

/**
 * A playable top-result card (video or song) as a Song. The card's subtitle
 * carries the credits ("Video • Artist • 1.4M views • 3:14").
 */
function cardSong(
	section: YTNodes.MusicCardShelf,
	videoId: string,
	thumbnail: string,
): Song {
	const runs = section.subtitle?.runs ?? [];
	const artists: Array<{ name: string; id?: string }> = [];
	let duration: string | undefined;
	for (const run of runs) {
		const text = (run as { text?: string }).text?.trim() ?? "";
		if (!text) continue;
		if (/^\d+(?::[0-5]\d)+$/.test(text)) duration = text;
		const browseId = (run as { endpoint?: { payload?: { browseId?: string } } })
			.endpoint?.payload?.browseId;
		if (!browseId?.startsWith("UC")) continue;
		if (artists.some((artist) => artist.name === text)) continue;
		artists.push({ name: text, id: browseId });
	}
	return {
		id: videoId,
		title: section.title?.toString().trim() || "Unknown Title",
		artist: artists.map((artist) => artist.name).join(", "),
		artistId: artists.find((artist) => artist.id)?.id,
		artists: artists.length > 0 ? artists : undefined,
		thumbnail,
		duration,
	};
}

/**
 * The entry a top-result card stands for. The card's tap target is the result
 * itself (an artist/album/playlist page or a video) — artists in particular
 * often appear nowhere else in the mixed list.
 */
function cardEntry(section: YTNodes.MusicCardShelf): SearchEntry | null {
	const payload = section.on_tap?.payload;
	const name = section.title?.toString().trim() ?? "";
	const subtitle = section.subtitle?.toString().trim() ?? "";
	const thumbnail = hiResThumb(biggestThumb(section.thumbnail?.contents)?.url);
	const videoId = payload?.videoId as string | undefined;
	if (isVideoId(videoId)) {
		return {
			kind: "playable",
			song: cardSong(section, videoId, thumbnail),
			top: true,
		};
	}
	const browseId = payload?.browseId as string | undefined;
	if (!browseId) return null;
	const cardPageType =
		payload?.browseEndpointContextSupportedConfigs
			?.browseEndpointContextMusicConfig?.pageType;
	if (cardPageType === "MUSIC_PAGE_TYPE_ARTIST" && browseId.startsWith("UC")) {
		return {
			kind: "artist",
			id: browseId,
			name: name || "Unknown Artist",
			subtitle: subtitle || "Artist",
			thumbnail,
			top: true,
		};
	}
	if (
		cardPageType === "MUSIC_PAGE_TYPE_ALBUM" ||
		cardPageType === "MUSIC_PAGE_TYPE_PLAYLIST"
	) {
		return {
			kind: "collection",
			id: browseId,
			title: name || "Unknown Title",
			subtitle,
			thumbnail,
			top: true,
		};
	}
	return null;
}

/** Artist rows leave `title` empty; their name lives in the first flex column. */
function rowName(item: YTNodes.MusicResponsiveListItem): string {
	const title = item.title?.trim();
	if (title) return title;
	const runs = item.flex_columns?.at(0)?.title?.runs ?? [];
	return runs
		.map((run) => (run as { text?: string }).text?.trim() ?? "")
		.join("")
		.trim();
}

/** The info column ("Album • Artist • Year") as the item renders it. */
function infoColumn(item: YTNodes.MusicResponsiveListItem): string {
	const runs = item.flex_columns?.at(1)?.title?.runs ?? [];
	return runs
		.map((run) => (run as { text?: string }).text ?? "")
		.join("")
		.trim();
}

/** Music page type of a browse row ("MUSIC_PAGE_TYPE_ARTIST", …) when present. */
function pageType(item: YTNodes.MusicResponsiveListItem): string {
	return (
		item.endpoint?.payload?.browseEndpointContextSupportedConfigs
			?.browseEndpointContextMusicConfig?.pageType ?? ""
	);
}

function toSong(
	item: YTNodes.MusicResponsiveListItem,
	/** Card-level artist for rows whose own credit is missing. */
	fallback?: { name: string; id?: string } | null,
): Song {
	const artists = artistListOf(item);
	const credit = fallback && !hasArtistCredit(artists) ? [fallback] : artists;
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: credit.map((artist) => artist.name).join(", "),
		artistId: credit.find((artist) => artist.id)?.id,
		artists: credit,
		thumbnail: hiResThumb(biggestThumb(item.thumbnail?.contents)?.url),
		duration: item.duration?.text,
	};
}

/**
 * Turns the rows of a search response into renderable entries for the active
 * tab. The filtered tabs only carry their own row type; "All" keeps every row
 * the app knows how to open — playable tracks plus artist channels, albums
 * and playlists, led by the top-result card. Rows of an artist card inherit
 * the card's artist, which YTM omits from the rows themselves.
 */
function toEntries(search: YTMusic.Search, tab: SearchTab): SearchEntry[] {
	const entries: SearchEntry[] = [];
	const seen = new Set<string>();
	const add = (entry: SearchEntry) => {
		const key = entryKey(entry);
		if (seen.has(key)) return;
		seen.add(key);
		entries.push(entry);
	};

	for (const section of search.contents ?? []) {
		// The top-result card is a result itself — YTM shows it as a bigger
		// card above the list, and artists can appear nowhere else.
		if (tab === "all" && section.is(YTNodes.MusicCardShelf)) {
			const card = cardEntry(section);
			if (card) {
				add(card);
				// The card's rows are the artist's top songs; render them inside
				// the card and consume them so they don't repeat as list rows.
				if (card.kind === "artist") {
					const fallback = cardArtist(section);
					const songs: Song[] = [];
					for (const item of section.contents ?? []) {
						if (!item.is(YTNodes.MusicResponsiveListItem)) continue;
						if (!videoIdOf(item)) continue;
						const row: SearchEntry = {
							kind: "playable",
							song: toSong(item, fallback),
						};
						const key = entryKey(row);
						if (seen.has(key)) continue;
						seen.add(key);
						songs.push(row.song);
					}
					card.songs = songs;
				}
			}
		}

		const fallback = cardArtist(section);
		for (const item of section.contents ?? []) {
			if (!item.is(YTNodes.MusicResponsiveListItem)) continue;
			const videoId = videoIdOf(item);
			if (videoId) {
				if (tab === "channel" || tab === "playlist" || tab === "album")
					continue;
				if (tab === "music" && item.item_type !== "song") continue;
				if (tab === "video" && item.item_type !== "video") continue;
				add({ kind: "playable", song: toSong(item, fallback) });
				continue;
			}

			if (item.item_type === "artist") {
				if (tab !== "all" && tab !== "channel") continue;
				// Search also mixes in user profiles ("Profile • @handle"); only
				// real artist channels have a page in the app.
				if (pageType(item) !== "MUSIC_PAGE_TYPE_ARTIST") continue;
				const id = item.endpoint?.payload?.browseId as string | undefined;
				if (!id) continue;
				add({
					kind: "artist",
					id,
					name: rowName(item) || "Unknown Artist",
					subtitle: item.subtitle?.toString() ?? "Artist",
					thumbnail: hiResThumb(biggestThumb(item.thumbnail?.contents)?.url),
				});
				continue;
			}

			if (tab !== "all" && tab !== item.item_type) continue;
			if (item.item_type === "album" || item.item_type === "playlist") {
				if (!item.id) continue;
				add({
					kind: "collection",
					id: item.id,
					title: item.title ?? "Unknown Title",
					subtitle: infoColumn(item) || item.author?.name || "",
					thumbnail: hiResThumb(biggestThumb(item.thumbnail?.contents)?.url),
				});
			}
		}
	}
	return entries;
}

/**
 * Backfills the lengths the mixed "All" rows omit, in one bulk queue request.
 * Covers both list rows and the top-result card's associated songs; no-op
 * when every track already has a duration.
 */
async function fillDurations(entries: SearchEntry[]): Promise<void> {
	const missing = entries
		.flatMap((entry) =>
			entry.kind === "playable" ? [entry.song] : (entry.songs ?? []),
		)
		.filter((song) => !song.duration);
	if (missing.length === 0) return;
	try {
		const durations = await getTrackDurations(missing.map((song) => song.id));
		for (const song of missing) {
			const duration = durations.get(song.id);
			if (duration) song.duration = duration;
		}
	} catch (error) {
		console.warn("[search] could not load track lengths:", error);
	}
}

/** Fisher–Yates shuffle, for the artist card's shuffle action. */
function shuffledSongs(songs: Song[]): Song[] {
	const shuffled = [...songs];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}

export default function SearchResults({ query }: SearchResultsPageProps) {
	const { play, playQueue, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	// Video entries already resolved to their song version while playing.
	const versions = useSongVersionReplacements();
	const navigate = useNavigate();
	const [tab, setTab] = useState<SearchTab>("all");
	const [view, setView] = useState<TabView>({ status: "loading" });
	// Fetched tabs of the current query, so switching tabs back and forth does
	// not re-query YouTube. The page is keyed by query, so caches never mix.
	const cache = useRef(new Map<SearchTab, SearchEntry[]>());
	const filter = TABS.find((entry) => entry.id === tab)?.type;

	// Switch the visible tab and its content in one update, so the previous
	// tab's rows never flash under the new tab while its fetch starts.
	const selectTab = (next: SearchTab) => {
		if (next === tab) return;
		setTab(next);
		const cached = cache.current.get(next);
		setView(
			cached ? { status: "ready", entries: cached } : { status: "loading" },
		);
	};

	useEffect(() => {
		if (!query || cache.current.has(tab)) return;
		let cancelled = false;

		(async () => {
			try {
				const youtube = await getYoutubeClient();
				if (tab === "channel") {
					const [web, music] = await Promise.allSettled([
						youtube.search(query, { type: "channel" }),
						youtube.music.search(query, { type: "artist" }),
					]);
					if (web.status === "rejected" && music.status === "rejected")
						throw web.reason;
					const entries: SearchEntry[] =
						web.status === "fulfilled"
							? channelSearchEntries(web.value.channels)
							: [];
					if (music.status === "fulfilled")
						for (const entry of toEntries(music.value, "channel")) {
							if (
								!entries.some(
									(existing) => entryKey(existing) === entryKey(entry),
								)
							)
								entries.push(entry);
						}
					if (!cancelled) {
						cache.current.set(tab, entries);
						setView({ status: "ready", entries });
					}
					return;
				}
				const search = await youtube.music.search(
					query,
					filter ? { type: filter } : {},
				);
				const entries = toEntries(search, tab);
				await fillDurations(entries);
				if (cancelled) return;
				cache.current.set(tab, entries);
				setView({ status: "ready", entries });
			} catch (err) {
				console.error("Search error:", err);
				if (!cancelled) setView({ status: "error" });
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [query, tab, filter]);

	const loading = view.status === "loading";
	const failed = view.status === "error";
	const results = view.status === "ready" ? view.entries : [];

	const openEntry = (entry: ArtistEntry | CollectionEntry) => {
		if (entry.kind === "artist") navigate(`/artist/${entry.id}`);
		else navigate(`/playlists/${entry.id}`);
	};

	const startShuffle = (songs: Song[]) => {
		const shuffled = shuffledSongs(songs);
		if (shuffled.length > 0) playQueue(shuffled, 0);
	};

	const startMix = async (artistId: string) => {
		const songs = await getArtistMixSongs(artistId);
		if (songs.length === 0) {
			showToast("Could not start mix");
			return;
		}
		playQueue(songs, 0);
	};

	return (
		<div>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<h2 className="flex items-baseline gap-2 text-sm text-muted-foreground">
					<span>
						{loading ? `Searching for "${query}"` : `Results for "${query}"`}
					</span>
					{!loading && !failed && (
						<span className="text-xs text-muted-foreground/50">
							({results.length})
						</span>
					)}
				</h2>
				<div className="flex flex-wrap items-center gap-1">
					{TABS.map((entry) => (
						<button
							aria-pressed={tab === entry.id}
							className={cn(
								"h-8 rounded-full px-3.5 text-xs font-medium transition-colors duration-150",
								tab === entry.id
									? "bg-primary/12 text-primary"
									: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
							)}
							key={entry.id}
							onClick={() => selectTab(entry.id)}
							type="button"
						>
							{entry.label}
						</button>
					))}
				</div>
			</div>

			{loading ? (
				<SearchSkeleton />
			) : failed ? (
				<h2 className="py-10 text-sm text-destructive">
					Failed to search YouTube. Please try again.
				</h2>
			) : (
				<>
					<div className="space-y-0.5">
						{results.map((entry, i) => {
							const shown = withSongVersions(entry, versions);
							if (shown.top) {
								return (
									<TopResultCard
										entry={shown}
										isPlaying={isPlaying}
										key={entryKey(entry)}
										onMix={startMix}
										onOpen={() => {
											if (shown.kind !== "playable") openEntry(shown);
										}}
										onPlay={(song) => play(song)}
										onQueue={(song) => addToQueue([song])}
										onShuffle={startShuffle}
										playingId={currentSong?.id}
									/>
								);
							}
							if (shown.kind === "playable") {
								return (
									<PlayableRow
										entry={shown}
										index={i}
										isCurrent={currentSong?.id === shown.song.id}
										isPlaying={isPlaying}
										key={entryKey(entry)}
										onPlay={() => play(shown.song)}
										onQueue={() => addToQueue([shown.song])}
									/>
								);
							}
							if (shown.kind === "artist") {
								return (
									<ArtistRow
										entry={shown}
										key={`artist-${shown.id}`}
										onClick={() => openEntry(shown)}
									/>
								);
							}
							return (
								<CollectionRow
									entry={shown}
									key={`collection-${shown.id}`}
									onClick={() => openEntry(shown)}
								/>
							);
						})}
					</div>
					{results.length === 0 && (
						<p className="py-10 text-sm text-muted-foreground">
							Nothing found — try a different search.
						</p>
					)}
				</>
			)}
		</div>
	);
}

/**
 * The search's top result — the bigger card YTM leads with. It can be a
 * playable video/song or a browse entity (artist, album, playlist), and is
 * sometimes the only place the entity appears in the All list. Artist cards
 * list their associated tracks and carry YTM's Shuffle / Mix actions.
 */
function TopResultCard({
	entry,
	playingId,
	isPlaying,
	onOpen,
	onPlay,
	onQueue,
	onShuffle,
	onMix,
}: {
	entry: SearchEntry;
	/** Id of the playing track, for the current-track highlight. */
	playingId?: string;
	isPlaying: boolean;
	onOpen: () => void;
	onPlay: (song: Song) => void;
	onQueue: (song: Song) => void;
	onShuffle: (songs: Song[]) => void;
	onMix: (artistId: string) => Promise<void>;
}) {
	const [mixPending, setMixPending] = useState(false);
	const songs = entry.songs ?? [];
	const isArtist = entry.kind === "artist";
	const isPlayable = entry.kind === "playable";
	const title = isPlayable
		? entry.song.title
		: entry.kind === "artist"
			? formatArtistName(entry.name)
			: entry.title;
	const thumbnail = isPlayable ? entry.song.thumbnail : entry.thumbnail;
	const Artwork = isArtist ? "img" : CoverImage;
	const isCurrent = isPlayable && playingId === entry.song.id;

	const runMix = async () => {
		if (entry.kind !== "artist" || mixPending) return;
		setMixPending(true);
		try {
			await onMix(entry.id);
		} finally {
			setMixPending(false);
		}
	};

	const card = (
		<div className="overflow-hidden rounded-xl border border-foreground/8 bg-foreground/3">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-3 sm:p-4">
				<button
					className="group flex min-w-0 flex-1 items-center gap-4 text-left"
					onClick={isPlayable ? () => onPlay(entry.song) : onOpen}
					type="button"
				>
					{thumbnail ? (
						<Artwork
							alt={title}
							className={cn(
								"size-18 shrink-0 rounded-xl border border-foreground/10 object-cover sm:size-22",
								isArtist && "rounded-full",
							)}
							loading="lazy"
							src={proxiedImageUrl(thumbnail)}
						/>
					) : (
						<div
							className={cn(
								"size-18 shrink-0 rounded-xl bg-muted sm:size-22",
								isArtist && "rounded-full",
							)}
						/>
					)}
					<div className="min-w-0 flex-1">
						<h3
							className={cn(
								"truncate text-lg font-bold tracking-tight transition-colors duration-150 group-hover:text-primary",
								isCurrent && "text-primary",
							)}
						>
							{isPlayable ? (
								<SongTitle
									artist={entry.song.artist}
									keepTitle={entry.song.upload}
									title={entry.song.title}
								/>
							) : (
								title
							)}
						</h3>
						<p className="mt-1 truncate text-sm text-muted-foreground">
							{isPlayable ? (
								<ArtistLinks showType song={entry.song} />
							) : (
								entry.subtitle
							)}
						</p>
					</div>
					{isPlayable && (
						<div className="flex shrink-0 items-center gap-2 pr-1">
							<DownloadedBadge songId={entry.song.id} />
							{isCurrent && isPlaying ? (
								<EqualizerBars className="size-3.5 text-primary" />
							) : (
								<span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
									{entry.song.duration}
								</span>
							)}
						</div>
					)}
				</button>
				{!isPlayable && (
					<div className="flex shrink-0 items-center gap-1.5">
						{songs.length > 0 && (
							<button
								className="flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-95"
								onClick={() => onShuffle(songs)}
								type="button"
							>
								<Shuffle className="size-4" />
								Shuffle
							</button>
						)}
						{isArtist && (
							<button
								className="flex h-9 items-center gap-1.5 rounded-full border border-foreground/12 px-4 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:opacity-60"
								disabled={mixPending}
								onClick={() => void runMix()}
								type="button"
							>
								{mixPending ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									<AudioLines className="size-4" />
								)}
								Mix
							</button>
						)}
						{entry.kind === "collection" && (
							<ChevronRight className="size-5 text-muted-foreground/50" />
						)}
					</div>
				)}
			</div>
			{songs.length > 0 && (
				<div className="border-t border-foreground/6 p-1">
					{songs.map((song, i) => (
						<PlayableRow
							entry={{ kind: "playable", song }}
							index={i}
							isCurrent={playingId === song.id}
							isPlaying={isPlaying}
							key={song.id}
							onPlay={() => onPlay(song)}
							onQueue={() => onQueue(song)}
						/>
					))}
				</div>
			)}
		</div>
	);

	if (entry.kind !== "playable")
		return <SearchEntityMenu entry={entry}>{card}</SearchEntityMenu>;
	return (
		<SongContextMenu song={entry.song}>
			<SwipeToQueue onQueue={() => onQueue(entry.song)}>{card}</SwipeToQueue>
		</SongContextMenu>
	);
}

function PlayableRow({
	entry,
	index,
	isCurrent,
	isPlaying,
	onPlay,
	onQueue,
}: {
	entry: PlayableEntry;
	index: number;
	isCurrent: boolean;
	isPlaying: boolean;
	onPlay: () => void;
	onQueue: () => void;
}) {
	const { song } = entry;
	return (
		<SongContextMenu song={song}>
			<SwipeToQueue onQueue={onQueue}>
				<button
					className={cn(
						"group grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/5",
						isCurrent && "bg-primary/8",
					)}
					onClick={onPlay}
					style={{ animationDelay: `${Math.min(index * 25, 300)}ms` }}
					type="button"
				>
					{song.thumbnail ? (
						<CoverImage
							alt={song.title}
							className="size-10 rounded-md border border-foreground/10 object-cover"
							loading="lazy"
							src={proxiedImageUrl(song.thumbnail)}
						/>
					) : (
						<div className="size-10 rounded-md bg-muted" />
					)}
					<div className="min-w-0">
						<h3
							className={cn(
								"truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary",
								isCurrent && "text-primary",
							)}
						>
							<SongTitle
								artist={song.artist}
								keepTitle={song.upload}
								title={song.title}
							/>
						</h3>
						<p className="truncate text-xs text-muted-foreground">
							<ArtistLinks showType song={song} />
						</p>
					</div>
					<div className="flex items-center gap-2 pr-1">
						<DownloadedBadge songId={song.id} />
						{isCurrent && isPlaying ? (
							<EqualizerBars className="size-3.5 text-primary" />
						) : (
							<span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
								{song.duration}
							</span>
						)}
					</div>
				</button>
			</SwipeToQueue>
		</SongContextMenu>
	);
}

function ArtistRow({
	entry,
	onClick,
}: {
	entry: ArtistEntry;
	onClick: () => void;
}) {
	return (
		<SearchEntityMenu entry={entry}>
			<button
				className="group grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/5"
				onClick={onClick}
				type="button"
			>
				{entry.thumbnail ? (
					<img
						alt={entry.name}
						className="size-10 rounded-full border border-foreground/10 object-cover"
						loading="lazy"
						src={proxiedImageUrl(entry.thumbnail)}
					/>
				) : (
					<div className="size-10 rounded-full bg-muted" />
				)}
				<div className="min-w-0">
					<h3 className="truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary">
						{formatArtistName(entry.name)}
					</h3>
					<p className="truncate text-xs text-muted-foreground">
						{entry.subtitle}
					</p>
				</div>
				<ChevronRight className="size-4 text-muted-foreground/50 transition-colors duration-150 group-hover:text-foreground" />
			</button>
		</SearchEntityMenu>
	);
}

function CollectionRow({
	entry,
	onClick,
}: {
	entry: CollectionEntry;
	onClick: () => void;
}) {
	return (
		<SearchEntityMenu entry={entry}>
			<button
				className="group grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/5"
				onClick={onClick}
				type="button"
			>
				{entry.thumbnail ? (
					<CoverImage
						alt={entry.title}
						className="size-10 rounded-md border border-foreground/10 object-cover"
						loading="lazy"
						src={proxiedImageUrl(entry.thumbnail)}
					/>
				) : (
					<div className="size-10 rounded-md bg-muted" />
				)}
				<div className="min-w-0">
					<h3 className="truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary">
						{entry.title}
					</h3>
					<p className="truncate text-xs text-muted-foreground">
						{entry.subtitle}
					</p>
				</div>
				<ChevronRight className="size-4 text-muted-foreground/50 transition-colors duration-150 group-hover:text-foreground" />
			</button>
		</SearchEntityMenu>
	);
}

function SearchEntityMenu({
	entry,
	children,
}: {
	entry: ArtistEntry | CollectionEntry;
	children: ReactNode;
}) {
	const { isPinned, togglePinned } = usePinnedPlaylists();
	if (entry.kind === "artist")
		return (
			<ArtistContextMenu artist={{ id: entry.id, name: entry.name }}>
				{children}
			</ArtistContextMenu>
		);
	return (
		<PlaylistContextMenu
			allowDelete={false}
			isPinned={isPinned(entry.id)}
			onTogglePinned={() =>
				togglePinned({
					id: entry.id,
					title: entry.title,
					thumbnail: entry.thumbnail,
				})
			}
			playlist={entry}
		>
			{children}
		</PlaylistContextMenu>
	);
}

function SearchSkeleton() {
	return (
		<div className="space-y-2">
			{Array.from({ length: 8 }, (_, i) => (
				<div
					className="animate-track-in flex items-center gap-3 px-2.5"
					// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
					key={i}
					style={{ animationDelay: `${i * 45}ms` }}
				>
					<div className="shimmer-surface size-10 rounded-md" />
					<div className="min-w-0 flex-1">
						<div className="shimmer-surface h-4 w-2/5 rounded-md" />
						<div className="shimmer-surface mt-2 h-3 w-1/4 rounded-md" />
					</div>
				</div>
			))}
		</div>
	);
}
