import {
	ArrowLeftIcon,
	ArrowUpRight,
	Music2,
	Pin,
	Play,
	RefreshCw,
	Search,
	Shuffle,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { ArtistLinks } from "@/components/artist-link";
import { SongTitle } from "@/components/song-title";
import { SwipeToQueue } from "@/components/swipe-to-queue";
import { Input } from "@/components/ui/input";
import { EqualizerBars } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { reconcilePinnedTitles, usePinnedPlaylists } from "@/lib/pinned";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn, hiResThumb } from "@/lib/utils";
import {
	artistIdOf,
	artistListOf,
	artistNames,
	isAlbumId,
	videoIdOf,
} from "../lib/youtube.utils";
import {
	type Album,
	getAlbum,
	getPlaylist,
	getUserPlaylists,
	loadPlaylistContinuation,
	type Playlist,
} from "../lib/youtube-client";

// Auto-sync policy: fetch on first use, persist to localStorage, then only
// re-sync after 24h — or when the user hits the refresh button.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// v6: the library is fetched in English; v5 and earlier could hold a locally
// localized (e.g. Japanese) auto-playlist name.
const LIBRARY_CACHE_KEY = "yumusic:library:v6";
const PLAYLIST_CACHE_PREFIX = "yumusic:playlist:v6:";

interface LibraryPlaylist {
	id: string;
	title: string;
	subtitle: string;
	thumbnail: string | null;
}

/** Plain-data snapshot of a playlist (JSON-safe for persistence). */
interface PlaylistView {
	title: string;
	subtitle: string;
	thumbnail: string | null;
	songs: Song[];
	complete: boolean;
}

interface CacheEntry<T> {
	timestamp: number;
	data: T;
}

function readCache<T>(key: string): CacheEntry<T> | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		return JSON.parse(raw) as CacheEntry<T>;
	} catch {
		return null;
	}
}

function writeCache<T>(key: string, data: T) {
	try {
		localStorage.setItem(
			key,
			JSON.stringify({ timestamp: Date.now(), data } satisfies CacheEntry<T>),
		);
	} catch {
		// quota exceeded — cache is best-effort
	}
}

function toSong(item: YTNodes.MusicResponsiveListItem): Song {
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: artistNames(item),
		artistId: artistIdOf(item.artists),
		artists: artistListOf(item),
		thumbnail: hiResThumb(
			item.thumbnail?.contents?.[item.thumbnail.contents.length - 1]?.url,
		),
		duration: item.duration?.text,
	};
}

function collectSongs(
	items: Iterable<
		| YTNodes.MusicResponsiveListItem
		| YTNodes.MusicTwoRowItem
		| YTNodes.ContinuationItem
	>,
): Song[] {
	const songs: Song[] = [];
	for (const item of items) {
		if (item.is(YTNodes.MusicResponsiveListItem)) {
			const song = toSong(item);
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
 * Title, subtitle and cover for a playlist or album header. Editable playlist
 * pages wrap their real header one level deep, and albums use a different
 * header class than playlists.
 */
function collectionHeader(raw: Playlist["header"] | Album["header"]): {
	title: string;
	subtitle: string;
	thumbnail: string | null;
} {
	const header =
		raw instanceof YTNodes.MusicEditablePlaylistDetailHeader ? raw.header : raw;
	if (header instanceof YTNodes.MusicResponsiveHeader) {
		const thumbs = header.thumbnail?.contents ?? [];
		return {
			title: header.title?.text || "Playlist",
			subtitle: header.subtitle?.text || "",
			thumbnail: hiResThumb(thumbs[thumbs.length - 1]?.url || null),
		};
	}
	if (header instanceof YTNodes.MusicDetailHeader) {
		return {
			title: header.title?.text || "Album",
			subtitle: header.subtitle?.text || "",
			thumbnail: hiResThumb(
				header.thumbnails?.[header.thumbnails.length - 1]?.url || null,
			),
		};
	}
	return { title: "Playlist", subtitle: "", thumbnail: null };
}

export function PlaylistDetails() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { play, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [playlist, setPlaylist] = useState<PlaylistView | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);

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
			const view: PlaylistView = {
				title: header.title,
				subtitle: cleanSubtitle(header.subtitle),
				thumbnail: header.thumbnail,
				songs: collectSongs(items),
				complete: !("has_continuation" in data && data.has_continuation),
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
					view.songs = [...view.songs, ...collectSongs(current.items ?? [])];
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

	// Search filter — matches titles and artist names, keeps the original
	// playlist position for numbering while queuing the visible songs.
	const query = search.trim().toLowerCase();
	const visible = songs
		.map((song, index) => ({ song, index }))
		.filter(({ song }) => {
			if (!query) return true;
			return [
				song.title,
				song.artist,
				...(song.artists ?? []).map((a) => a.name),
			]
				.filter(Boolean)
				.some((text) => text.toLowerCase().includes(query));
		});

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
							play(songs[0], songs.slice(1));
						}}
						title="Play all"
						type="button"
					>
						<Play className="size-5 translate-x-px fill-current" />
					</button>
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
				{visible.map(({ song, index }) => {
					const isCurrent = currentSong?.id === song.id;

					return (
						<SwipeToQueue
							key={`${song.id ?? "playlist-item"}-${index}`}
							onQueue={() => addToQueue([song])}
						>
							<button
								className={cn(
									"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors duration-150 hover:bg-foreground/5 sm:px-2.5",
									isCurrent && "bg-primary/8",
								)}
								onClick={() =>
									play(
										song,
										visible
											.slice(visible.findIndex((v) => v.index === index) + 1)
											.map((v) => v.song),
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
												{index + 1}
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
			const library = await getUserPlaylists();

			if (!library) {
				setError("Failed to load playlists.");
				return;
			}

			// The library renders playlists either as square grid tiles
			// (MusicTwoRowItem) or as list rows (MusicResponsiveListItem),
			// depending on the section layout — accept both.
			const list: LibraryPlaylist[] = [];
			for (const section of library.contents ?? []) {
				for (const item of section.contents ?? []) {
					if (item.is(YTNodes.MusicTwoRowItem)) {
						if (item.item_type !== "playlist") continue;
						list.push({
							id: item.id || "",
							title: item.title?.text || "Unknown Title",
							subtitle: cleanSubtitle(item.subtitle?.text || ""),
							thumbnail: hiResThumb(
								item.thumbnail?.[item.thumbnail.length - 1]?.url || null,
							),
						});
					} else if (item.is(YTNodes.MusicResponsiveListItem)) {
						if (item.item_type !== "playlist") continue;
						const thumbs = item.thumbnail?.contents ?? [];
						list.push({
							id: item.id || "",
							title: item.title || "Unknown Title",
							subtitle: cleanSubtitle(item.subtitle?.text || ""),
							thumbnail: hiResThumb(thumbs[thumbs.length - 1]?.url || null),
						});
					}
				}
			}
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
