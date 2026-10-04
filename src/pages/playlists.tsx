import { Menu } from "@base-ui/react/menu";
import {
	ArrowLeftIcon,
	ArrowUpDown,
	ArrowUpRight,
	Check,
	Music2,
	Pin,
	Play,
	RefreshCw,
	Search,
	Share2,
	Shuffle,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { EqualizerBars } from "@/components/player/waveform";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import { Input } from "@/components/ui/input";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { shareLink } from "@/lib/services/share";
import { reconcilePinnedTitles, usePinnedPlaylists } from "@/lib/stores/pinned";
import {
	LIBRARY_CACHE_KEY,
	PLAYLIST_CACHE_PREFIX,
	type PlaylistView,
	readCache,
	SYNC_INTERVAL_MS,
	writeCache,
} from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { useDisplayTitle } from "@/lib/utils/title";
import { cn, hiResThumb, parseDuration } from "@/lib/utils/utils";
import {
	artistListOf,
	isAlbumId,
	videoIdOf,
} from "../lib/youtube/youtube.utils";
import {
	type Album,
	getAlbum,
	getLibraryPlaylists,
	getPlaylist,
	type LibraryPlaylist,
	loadPlaylistContinuation,
	type Playlist,
	removeSongFromPlaylist,
} from "../lib/youtube/youtube-client";

/** Whether parsed credits name a real artist, not the unknown placeholder. */
function hasArtistCredit(artists: Array<{ name: string }>): boolean {
	return artists.some((artist) => {
		const name = artist.name?.trim();
		return !!name && !/^unknown artist$/i.test(name);
	});
}

/** Header-level info used for rows that carry no per-track credit or art. */
interface RowFallback {
	artists?: Array<{ name: string; id?: string }>;
	thumbnail?: string | null;
}

/**
 * Album rows usually omit both the artist and the artwork (the header holds
 * them), so album pages pass those down as a fallback for rows without them.
 */
function toSong(
	item: YTNodes.MusicResponsiveListItem,
	fallback?: RowFallback,
): Song {
	const artists = artistListOf(item);
	const credit =
		fallback?.artists && !hasArtistCredit(artists) ? fallback.artists : artists;
	const rowThumb =
		item.thumbnail?.contents?.[item.thumbnail.contents.length - 1]?.url;
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: credit.map((artist) => artist.name).join(", "),
		artistId: credit.find((artist) => artist.id)?.id,
		artists: credit,
		thumbnail: hiResThumb(rowThumb) || fallback?.thumbnail || "",
		duration: item.duration?.text,
	};
}

function collectSongs(
	items: Iterable<
		| YTNodes.MusicResponsiveListItem
		| YTNodes.MusicTwoRowItem
		| YTNodes.ContinuationItem
	>,
	fallback?: RowFallback,
): Song[] {
	const songs: Song[] = [];
	for (const item of items) {
		if (item.is(YTNodes.MusicResponsiveListItem)) {
			const song = toSong(item, fallback);
			if (song.id) songs.push(song);
		}
	}
	return songs;
}

/** Removes the redundant "Playlist" prefix from YouTube subtitles. */
function cleanSubtitle(text: string): string {
	return text.replace(/^playlist\s*[•·|:-]?\s*/i, "").trim();
}

/**
 * Artist credits stored on the header. Album track rows omit the artist, so
 * it must be read from the album header instead: the strapline on the current
 * layout ("Nakuru Aitsuki"), the author on older responses.
 */
function headerArtists(
	header: YTNodes.MusicResponsiveHeader | YTNodes.MusicDetailHeader,
): Array<{ name: string; id?: string }> {
	if (header instanceof YTNodes.MusicDetailHeader) {
		const author = header.author;
		return author?.name
			? [
					{
						name: author.name,
						id: author.channel_id?.startsWith("UC")
							? author.channel_id
							: undefined,
					},
				]
			: [];
	}
	const artists: Array<{ name: string; id?: string }> = [];
	for (const run of header.strapline_text_one?.runs ?? []) {
		const name = run.text?.trim();
		if (!name || /^[\s,、&/•·]+$/.test(name)) continue;
		if (artists.some((artist) => artist.name === name)) continue;
		const browseId = (run as { endpoint?: { payload?: { browseId?: string } } })
			.endpoint?.payload?.browseId;
		artists.push({
			name,
			id: browseId?.startsWith("UC") ? browseId : undefined,
		});
	}
	return artists;
}

/**
 * Title, subtitle, cover and header-level artists for a playlist or album.
 * Editable playlist pages wrap their real header one level deep, and albums
 * use a different header class than playlists.
 */
function collectionHeader(raw: Playlist["header"] | Album["header"]): {
	title: string;
	subtitle: string;
	thumbnail: string | null;
	artists: Array<{ name: string; id?: string }>;
} {
	const header =
		raw instanceof YTNodes.MusicEditablePlaylistDetailHeader ? raw.header : raw;
	if (header instanceof YTNodes.MusicResponsiveHeader) {
		const thumbs = header.thumbnail?.contents ?? [];
		return {
			title: header.title?.text || "Playlist",
			subtitle: header.subtitle?.text || "",
			thumbnail: hiResThumb(thumbs[thumbs.length - 1]?.url || null),
			artists: headerArtists(header),
		};
	}
	if (header instanceof YTNodes.MusicDetailHeader) {
		return {
			title: header.title?.text || "Album",
			subtitle: header.subtitle?.text || "",
			thumbnail: hiResThumb(
				header.thumbnails?.[header.thumbnails.length - 1]?.url || null,
			),
			artists: headerArtists(header),
		};
	}
	return { title: "Playlist", subtitle: "", thumbnail: null, artists: [] };
}

/**
 * Owned playlists nest an editable header renderer in the browse response.
 * It is checked through the response memo as well: youtubei.js' `header`
 * can resolve to the inner MusicResponsiveHeader instead of the wrapper.
 */
function isEditablePlaylist(data: Playlist | Album): boolean {
	if (data.header instanceof YTNodes.MusicEditablePlaylistDetailHeader) {
		return true;
	}
	const editable = data.page?.contents_memo?.getType(
		YTNodes.MusicEditablePlaylistDetailHeader,
	);
	return (editable?.length ?? 0) > 0;
}

type PlaylistSort =
	| "newest"
	| "oldest"
	| "title-asc"
	| "title-desc"
	| "artist-asc"
	| "artist-desc"
	| "shortest"
	| "longest";

const PLAYLIST_SORTS: Array<{ value: PlaylistSort; label: string }> = [
	{ value: "newest", label: "Newest first" },
	{ value: "oldest", label: "Oldest first" },
	{ value: "title-asc", label: "Title A–Z" },
	{ value: "title-desc", label: "Title Z–A" },
	{ value: "artist-asc", label: "Artist A–Z" },
	{ value: "artist-desc", label: "Artist Z–A" },
	{ value: "shortest", label: "Shortest first" },
	{ value: "longest", label: "Longest first" },
];

export function PlaylistDetails() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { play, playQueue, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [playlist, setPlaylist] = useState<PlaylistView | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [sort, setSort] = useState<PlaylistSort>("newest");
	const displayTitle = useDisplayTitle();

	const fetchPlaylist = async (force = false) => {
		if (!id) return;
		const cacheKey = PLAYLIST_CACHE_PREFIX + id;

		const cached = readCache<PlaylistView>(cacheKey);
		if (
			!force &&
			cached &&
			cached.data.complete &&
			Date.now() - cached.timestamp < SYNC_INTERVAL_MS
		) {
			setPlaylist(cached.data);
			setLoading(false);
			return;
		}

		try {
			setLoading(true);
			setError(null);
			const albumMode = isAlbumId(id);
			const data = albumMode ? await getAlbum(id) : await getPlaylist(id);

			if (!data) {
				setError(
					albumMode ? "Failed to load album." : "Failed to load playlist.",
				);
				setLoading(false);
				return;
			}

			const header = collectionHeader(data.header);
			const items = "items" in data ? (data.items ?? []) : data.contents;
			const rowFallback: RowFallback = {
				artists: albumMode ? header.artists : undefined,
				thumbnail: header.thumbnail,
			};
			const view: PlaylistView = {
				title: header.title,
				subtitle: cleanSubtitle(header.subtitle),
				thumbnail: header.thumbnail,
				songs: collectSongs(items, rowFallback),
				complete: !("has_continuation" in data && data.has_continuation),
				editable: !albumMode && isEditablePlaylist(data),
			};
			setPlaylist(view);
			setLoading(false);

			// Load remaining pages, appending as they arrive (playlists only —
			// albums fit in a single response).
			if ("has_continuation" in data && data.has_continuation) {
				setLoadingMore(true);
				let current: Playlist = data;
				while (current.has_continuation) {
					const continuation = await loadPlaylistContinuation(current);
					if (!continuation) break;
					current = continuation;
					view.songs = [
						...view.songs,
						...collectSongs(current.items ?? [], rowFallback),
					];
					setPlaylist({ ...view, songs: [...view.songs] });
				}
				view.complete = !current.has_continuation;
				setLoadingMore(false);
			}

			writeCache(cacheKey, view);
		} catch (err) {
			console.error("Error fetching playlist:", err);
			// Stale cache beats an error screen
			if (cached) setPlaylist(cached.data);
			else setError("Failed to load playlist.");
			setLoading(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchPlaylist changes on every re-render and should not be used as a hook dependency.
	useEffect(() => {
		fetchPlaylist();
		setSearch("");
	}, [id]);

	// Return to wherever the user came from (home, search, an artist, another
	// playlist…), not a fixed destination.
	const onBack = () => navigate(-1);

	/**
	 * Removes one playlist entry. The row index keeps a duplicated video from
	 * clearing every occurrence locally; the server removes the entry matched
	 * by its set-video id.
	 */
	const removeSong = async (song: Song, index: number) => {
		if (!id) return;
		try {
			await removeSongFromPlaylist(id, song.id);
			setPlaylist((prev) => {
				if (!prev) return prev;
				const next = {
					...prev,
					songs: prev.songs.filter((_, i) => i !== index),
				};
				writeCache(PLAYLIST_CACHE_PREFIX + id, next);
				return next;
			});
			showToast("Removed from playlist");
		} catch (error) {
			console.error("[YuMusic] remove from playlist failed:", error);
			showToast("Could not remove from playlist");
		}
	};

	if (loading) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
				<div className="shimmer-surface h-9 w-24 rounded-full" />
				<div className="mt-8 flex gap-6">
					<div className="shimmer-surface size-44 rounded-xl" />
					<div className="flex flex-1 flex-col justify-end gap-3 pb-2">
						<div className="shimmer-surface h-10 w-2/3 rounded-lg" />
						<div className="shimmer-surface h-3.5 w-40 rounded-md" />
					</div>
				</div>
				<div className="mt-10 space-y-2">
					{[1, 2, 3, 4, 5, 6].map((i) => (
						<div className="shimmer-surface h-14 rounded-lg" key={`row-${i}`} />
					))}
				</div>
			</div>
		);
	}

	if (error || !playlist) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
				<BackButton onClick={onBack} />
				<h2 className="mt-8 text-lg font-semibold text-destructive">
					{error || "Playlist not found."}
				</h2>
			</div>
		);
	}

	const { songs } = playlist;
	const showCount =
		songs.length > 0 && !/\d+\s+songs?\b/i.test(playlist.subtitle);

	// Search filter — matches titles and artist names. Rows keep their original
	// playlist position for numbering unless a sort is active. YouTube Music
	// returns a playlist newest-first (new additions land at the top), so
	// "newest" needs no work and "oldest" reverses it. Ties keep that order.
	const query = search.trim().toLowerCase();
	const ordered = songs.map((song, index) => ({ song, index }));
	if (sort !== "newest") {
		const titles = new Map<number, string>();
		const titleKey = (entry: { song: Song; index: number }) => {
			let key = titles.get(entry.index);
			if (key === undefined) {
				key = displayTitle(entry.song.title);
				titles.set(entry.index, key);
			}
			return key;
		};
		const collator = (a: string, b: string) =>
			a.localeCompare(b, undefined, { sensitivity: "base" });
		ordered.sort((a, b) => {
			let result = 0;
			switch (sort) {
				case "oldest":
					result = b.index - a.index;
					break;
				case "title-asc":
					result = collator(titleKey(a), titleKey(b));
					break;
				case "title-desc":
					result = collator(titleKey(b), titleKey(a));
					break;
				case "artist-asc":
					result = collator(a.song.artist ?? "", b.song.artist ?? "");
					break;
				case "artist-desc":
					result = collator(b.song.artist ?? "", a.song.artist ?? "");
					break;
				case "shortest":
					result =
						parseDuration(a.song.duration) - parseDuration(b.song.duration);
					break;
				case "longest":
					result =
						parseDuration(b.song.duration) - parseDuration(a.song.duration);
					break;
			}
			return result || a.index - b.index;
		});
	}
	const visible = ordered.filter(({ song }) => {
		if (!query) return true;
		return [song.title, song.artist, ...(song.artists ?? []).map((a) => a.name)]
			.filter(Boolean)
			.some((text) => text.toLowerCase().includes(query));
	});
	/** Display order for "Play all", including rows hidden by the search. */
	const playOrder = ordered.map((entry) => entry.song);
	const activeSort =
		PLAYLIST_SORTS.find((option) => option.value === sort)?.label ??
		"Newest first";

	return (
		<div className="mx-auto w-full max-w-7xl px-6 pt-6 sm:px-10 sm:pt-10">
			<div className="flex items-center justify-between">
				<BackButton onClick={onBack} />
				<button
					className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
					disabled={loading}
					onClick={() => fetchPlaylist(true)}
					title="Refresh playlist"
					type="button"
				>
					<RefreshCw className={cn("size-4", loading && "animate-spin")} />
				</button>
			</div>

			{/* Header — cover on top, identity + icon actions below, centered */}
			<header className="animate-track-in mt-4 text-center sm:mt-6">
				{playlist.thumbnail ? (
					<img
						alt={playlist.title}
						className="mx-auto size-36 rounded-xl border border-foreground/10 object-cover sm:size-40"
						loading="lazy"
						src={proxiedImageUrl(playlist.thumbnail)}
					/>
				) : (
					<div className="mx-auto grid size-36 place-items-center rounded-xl border border-foreground/10 bg-card sm:size-40">
						<Music2 className="size-10 text-muted-foreground" />
					</div>
				)}
				<h1 className="mt-4 truncate text-3xl font-bold tracking-tight sm:text-4xl">
					{playlist.title}
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					{[
						playlist.subtitle,
						showCount
							? `${songs.length} ${songs.length === 1 ? "track" : "tracks"}`
							: "",
					]
						.filter(Boolean)
						.join(" · ")}
				</p>
				<div className="mt-4 flex items-center justify-center gap-2">
					<button
						aria-label="Share playlist"
						className="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95"
						onClick={() => {
							const rawId = id?.startsWith("VL") ? id.slice(2) : id;
							void shareLink({
								title: playlist.title,
								url: `https://music.youtube.com/playlist?list=${rawId}`,
							});
						}}
						title="Share playlist"
						type="button"
					>
						<Share2 className="size-5" />
					</button>
					<button
						aria-label="Shuffle play"
						className="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
						disabled={songs.length < 2}
						onClick={() => {
							const shuffled = [...songs];
							for (let i = shuffled.length - 1; i > 0; i--) {
								const j = Math.floor(Math.random() * (i + 1));
								[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
							}
							play(shuffled[0], shuffled.slice(1));
						}}
						title="Shuffle play"
						type="button"
					>
						<Shuffle className="size-5" />
					</button>
					<button
						aria-label="Play all"
						className="grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_16px_-4px_color-mix(in_oklab,var(--primary)_60%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
						disabled={songs.length === 0}
						onClick={() => {
							play(playOrder[0], playOrder.slice(1));
						}}
						title="Play all"
						type="button"
					>
						<Play className="size-5 translate-x-px fill-current" />
					</button>
					{songs.length > 1 && (
						<Menu.Root>
							<Menu.Trigger
								aria-label={`Sort playlist (${activeSort})`}
								className="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 data-popup-open:border-primary/40 data-popup-open:text-primary"
								title={`Sort: ${activeSort}`}
							>
								<ArrowUpDown className="size-5" />
							</Menu.Trigger>
							<Menu.Portal>
								<Menu.Positioner
									align="center"
									className="z-90 outline-none"
									sideOffset={8}
								>
									<Menu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
										<Menu.RadioGroup
											onValueChange={(value) => setSort(value as PlaylistSort)}
											value={sort}
										>
											{PLAYLIST_SORTS.map((option) => (
												<Menu.RadioItem
													className="flex cursor-default items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
													key={option.value}
													value={option.value}
												>
													{option.label}
													<Menu.RadioItemIndicator className="text-primary">
														<Check className="size-4" />
													</Menu.RadioItemIndicator>
												</Menu.RadioItem>
											))}
										</Menu.RadioGroup>
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.Root>
					)}
					{/* Search — collapsed into the action row; expands in place */}
					{songs.length > 0 &&
						(searchOpen ? (
							<div className="relative w-64">
								<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
								<Input
									autoFocus
									className="h-11 rounded-full pr-8 pl-9"
									onChange={(event) => setSearch(event.target.value)}
									placeholder="Search in playlist"
									value={search}
								/>
								<button
									aria-label={search ? "Clear search" : "Close search"}
									className="absolute top-1/2 right-2 -translate-y-1/2 grid size-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
									onClick={() => {
										if (search) {
											setSearch("");
										} else {
											setSearchOpen(false);
										}
									}}
									type="button"
								>
									<X className="size-4" />
								</button>
							</div>
						) : (
							<button
								aria-label="Search in playlist"
								className="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95"
								onClick={() => setSearchOpen(true)}
								title="Search in playlist"
								type="button"
							>
								<Search className="size-5" />
							</button>
						))}
				</div>
			</header>

			{/* Tracklist — edge-to-edge on mobile */}
			<div className="mt-8 space-y-0.5 pb-4 -mx-6 sm:mx-0">
				{loadingMore && (
					<p className="mb-2 flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground sm:px-0">
						<EqualizerBars className="size-3 text-primary" />
						Loading more…
					</p>
				)}
				{visible.map(({ song, index }, i) => {
					const isCurrent = currentSong?.id === song.id;

					return (
						<SongContextMenu
							key={`${song.id ?? "playlist-item"}-${index}`}
							onRemove={
								playlist.editable
									? () => void removeSong(song, index)
									: undefined
							}
							song={song}
						>
							<SwipeToQueue onQueue={() => addToQueue([song])}>
								<button
									className={cn(
										"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors duration-150 hover:bg-foreground/5 sm:px-2.5",
										isCurrent && "bg-primary/8",
									)}
									onClick={() =>
										playQueue(
											visible.map((v) => v.song),
											i,
										)
									}
									type="button"
								>
									{/* Index / play / EQ */}
									<span className="relative grid place-items-center">
										{isCurrent ? (
											<EqualizerBars
												className="size-3.5 text-primary"
												playing={isPlaying}
											/>
										) : (
											<>
												<span className="font-mono text-xs text-muted-foreground/60 transition-opacity duration-150 group-hover:opacity-0">
													{sort === "newest" ? index + 1 : i + 1}
												</span>
												<Play className="absolute size-3.5 fill-current scale-75 text-foreground opacity-0 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100" />
											</>
										)}
									</span>

									{/* Thumbnail */}
									{song.thumbnail ? (
										<img
											alt={song.title}
											className="size-10 rounded-md border border-foreground/10 object-cover"
											loading="lazy"
											src={proxiedImageUrl(song.thumbnail)}
										/>
									) : (
										<div className="size-10 rounded-md bg-muted" />
									)}

									{/* Title + artists */}
									<div className="min-w-0">
										<h3
											className={cn(
												"truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary",
												isCurrent && "text-primary",
											)}
										>
											<SongTitle artist={song.artist} title={song.title} />
										</h3>
										<p className="truncate text-xs text-muted-foreground">
											<ArtistLinks song={song} />
										</p>
									</div>

									{/* Duration */}
									<span className="pr-2 font-mono text-xs text-muted-foreground/70 tabular-nums">
										{song.duration}
									</span>
								</button>
							</SwipeToQueue>
						</SongContextMenu>
					);
				})}
				{visible.length === 0 && search.trim() && songs.length > 0 && (
					<p className="px-4 py-10 text-sm text-muted-foreground sm:px-0">
						No tracks match "{search.trim()}".
					</p>
				)}
				{songs.length === 0 && (
					<p className="px-4 py-10 text-sm text-muted-foreground sm:px-0">
						This playlist is empty.
					</p>
				)}
			</div>
		</div>
	);
}

export default function PlaylistsPage() {
	const navigate = useNavigate();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const [playlists, setPlaylists] = useState<LibraryPlaylist[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchPlaylists = async (force = false) => {
		const cached = readCache<LibraryPlaylist[]>(LIBRARY_CACHE_KEY);
		// An empty cached list is treated as absent: it usually means a fetch
		// raced the login cookie, and caching it for 24h would pin the
		// "no playlists" state even after the session is available.
		const cacheUsable = !!cached && cached.data.length > 0;
		if (
			!force &&
			cached &&
			cacheUsable &&
			Date.now() - cached.timestamp < SYNC_INTERVAL_MS
		) {
			setPlaylists(cached.data);
			setLoading(false);
			return;
		}

		try {
			setLoading(true);
			setError(null);
			const list = (await getLibraryPlaylists(force)).map((playlist) => ({
				...playlist,
				subtitle: cleanSubtitle(playlist.subtitle),
			}));
			setPlaylists(list);
			reconcilePinnedTitles(list);
			if (list.length > 0) writeCache(LIBRARY_CACHE_KEY, list);
		} catch (err) {
			console.error("Error fetching playlists:", err);
			// Stale cache beats an error screen
			if (cacheUsable && cached) setPlaylists(cached.data);
			else setError("Failed to load playlists.");
		} finally {
			setLoading(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchPlaylists changes on every re-render and should not be used as a hook dependency.
	useEffect(() => {
		fetchPlaylists();
	}, []);

	if (loading) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
				<div className="shimmer-surface mb-8 h-8 w-48 rounded-lg" />
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
					{Array.from({ length: 10 }, (_, i) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
							key={`library-skeleton-${i}`}
						>
							<div className="shimmer-surface aspect-square rounded-xl" />
							<div className="shimmer-surface mt-3 h-4 w-3/4 rounded-md" />
						</div>
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
				<h2 className="text-lg font-semibold text-destructive">{error}</h2>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
			<div className="mb-8 flex items-center justify-between">
				<h1 className="text-2xl font-bold tracking-tight">Playlists</h1>
				<button
					className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
					disabled={loading}
					onClick={() => fetchPlaylists(true)}
					title="Refresh library"
					type="button"
				>
					<RefreshCw className={cn("size-4", loading && "animate-spin")} />
				</button>
			</div>

			<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
				{playlists.map((item, index) => (
					<div
						className="group animate-track-in relative"
						key={item.id}
						style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
					>
						<button
							className="block w-full overflow-hidden rounded-xl border border-foreground/8 bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40"
							onClick={() => navigate(`/playlists/${item.id}`)}
							type="button"
						>
							<div className="relative aspect-square overflow-hidden bg-muted">
								{item.thumbnail ? (
									<img
										alt={item.title}
										className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
										loading="lazy"
										src={proxiedImageUrl(item.thumbnail)}
									/>
								) : (
									<div className="grid size-full place-items-center text-muted-foreground">
										<Music2 className="size-8" />
									</div>
								)}
								<span className="absolute top-2.5 right-2.5 grid size-7 translate-y-1 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
									<ArrowUpRight className="size-3.5" />
								</span>
							</div>
							<div className="p-3.5">
								<h3 className="line-clamp-1 text-sm font-medium transition-colors duration-150 group-hover:text-primary">
									{item.title}
								</h3>
								<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
									{item.subtitle}
								</p>
							</div>
						</button>
						<button
							aria-label={
								isPinned(item.id) ? "Unpin from sidebar" : "Pin to sidebar"
							}
							className={cn(
								"absolute top-2.5 left-2.5 grid size-7 -translate-y-1 place-items-center rounded-full backdrop-blur-sm transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100",
								isPinned(item.id)
									? "bg-primary text-primary-foreground opacity-100"
									: "bg-black/55 text-white opacity-0 hover:bg-black/70",
							)}
							onClick={() =>
								togglePinned({
									id: item.id,
									title: item.title,
									thumbnail: item.thumbnail,
								})
							}
							title={
								isPinned(item.id) ? "Unpin from sidebar" : "Pin to sidebar"
							}
							type="button"
						>
							<Pin
								className={cn("size-3.5", isPinned(item.id) && "fill-current")}
							/>
						</button>
					</div>
				))}
			</div>
			{playlists.length === 0 && (
				<p className="py-12 text-sm text-muted-foreground">
					No playlists found in your library yet.
				</p>
			)}
		</div>
	);
}

function BackButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
			onClick={onClick}
			type="button"
		>
			<span className="grid size-8 place-items-center rounded-full border border-foreground/10 transition-colors group-hover:border-primary/40">
				<ArrowLeftIcon className="size-4" />
			</span>
			Back
		</button>
	);
}
