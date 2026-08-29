import {
	ArrowLeftIcon,
	ArrowUpRight,
	Music2,
	Pin,
	Play,
	RefreshCw,
	Shuffle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { ArtistLinks } from "@/components/artist-link";
import { Thumb } from "@/components/thumb";
import { EqualizerBars } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { usePinnedPlaylists } from "@/lib/pinned";
import { cn } from "@/lib/utils";
import { artistIdOf, artistListOf, artistNames } from "../lib/youtube.utils";
import {
	getPlaylist,
	getUserPlaylists,
	loadPlaylistContinuation,
	type Playlist,
} from "../lib/youtube-client";

// Auto-sync policy: fetch on first use, persist to localStorage, then only
// re-sync after 24h — or when the user hits the refresh button.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// v3: cache entries carry the per-artist links (v2 entries predate them)
const LIBRARY_CACHE_KEY = "yumusic:library:v3";
const PLAYLIST_CACHE_PREFIX = "yumusic:playlist:v3:";

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
		id: item.id ?? "",
		title: item.title ?? "Unknown Title",
		artist: artistNames(item),
		artistId: artistIdOf(item.artists),
		artists: artistListOf(item),
		thumbnail:
			item.thumbnail?.contents?.[item.thumbnail.contents.length - 1]?.url || "",
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
			songs.push(toSong(item));
		}
	}
	return songs;
}

/** Removes the redundant "Playlist" prefix from YouTube subtitles. */
function cleanSubtitle(text: string): string {
	return text.replace(/^playlist\s*[•·|:-]?\s*/i, "").trim();
}

export function PlaylistDetails() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { play, currentSong, isPlaying } = usePlayer();
	const [playlist, setPlaylist] = useState<PlaylistView | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);

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
			const data = await getPlaylist(id);

			if (!data) {
				setError("Failed to load playlist.");
				setLoading(false);
				return;
			}

			const header =
				data.header instanceof YTNodes.MusicResponsiveHeader
					? data.header
					: null;
			const view: PlaylistView = {
				title: header?.title?.text || "Playlist",
				subtitle: cleanSubtitle(header?.subtitle?.text || ""),
				thumbnail:
					header?.thumbnail?.contents?.[header.thumbnail.contents.length - 1]
						?.url || null,
				songs: collectSongs(data.items ?? []),
				complete: !data.has_continuation,
			};
			setPlaylist(view);
			setLoading(false);

			// Load remaining pages, appending as they arrive
			if (data.has_continuation) {
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
	}, [id]);

	const onBack = () => navigate("/playlists");

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

	return (
		<div className="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
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

			{/* Header */}
			<header className="animate-track-in mt-6 flex items-end gap-6">
				{playlist.thumbnail ? (
					<Thumb
						alt={playlist.title}
						className="size-40 shrink-0 rounded-xl border border-foreground/10 object-cover sm:size-48"
						loading="lazy"
						src={playlist.thumbnail}
					/>
				) : (
					<div className="grid size-40 shrink-0 place-items-center rounded-xl border border-foreground/10 bg-card sm:size-48">
						<Music2 className="size-10 text-muted-foreground" />
					</div>
				)}
				<div className="min-w-0 pb-1">
					<h1 className="truncate text-3xl font-bold tracking-tight sm:text-4xl">
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
					<div className="mt-4 flex items-center gap-2.5">
						<button
							className="flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
							disabled={songs.length === 0}
							onClick={() => {
								play(songs[0], songs.slice(1));
							}}
							type="button"
						>
							<Play className="size-4 translate-x-[1px] fill-current" />
							Play all
						</button>
						<button
							className="flex h-10 items-center gap-2 rounded-full border border-foreground/12 px-5 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
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
							<Shuffle className="size-4" />
							Shuffle
						</button>
					</div>
				</div>
			</header>

			{/* Tracklist */}
			<div className="mt-8 space-y-0.5 pb-4">
				{loadingMore && (
					<p className="mb-2 flex items-center gap-2 py-1 text-xs text-muted-foreground">
						<EqualizerBars className="size-3 text-primary" />
						Loading more…
					</p>
				)}
				{songs.map((song, index) => {
					const isCurrent = currentSong?.id === song.id;

					return (
						<button
							className={cn(
								"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.05]",
								isCurrent && "bg-primary/[0.08]",
							)}
							key={song.id || `playlist-item-${index}`}
							onClick={() => play(song, songs.slice(index + 1))}
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
								<Thumb
									alt={song.title}
									className="size-10 rounded-md border border-foreground/10 object-cover"
									loading="lazy"
									src={song.thumbnail}
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
									{song.title}
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
					);
				})}
				{songs.length === 0 && (
					<p className="py-10 text-sm text-muted-foreground">
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
		if (!force && cached && Date.now() - cached.timestamp < SYNC_INTERVAL_MS) {
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

			const foundItems: YTNodes.MusicTwoRowItem[] = [];
			for (const section of library.contents ?? []) {
				if (section.contents) {
					foundItems.push(
						...section.contents.filterType(YTNodes.MusicTwoRowItem),
					);
				}
			}

			const list: LibraryPlaylist[] = foundItems
				.filter((item) => item.item_type === "playlist")
				.map((item) => ({
					id: item.id || "",
					title: item.title?.text || "Unknown Title",
					subtitle: cleanSubtitle(item.subtitle?.text || ""),
					thumbnail: item.thumbnail?.[item.thumbnail.length - 1]?.url || null,
				}));
			setPlaylists(list);
			writeCache(LIBRARY_CACHE_KEY, list);
		} catch (err) {
			console.error("Error fetching playlists:", err);
			// Stale cache beats an error screen
			if (cached) setPlaylists(cached.data);
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
			<div className="mx-auto w-full max-w-5xl px-6 pt-12 sm:px-10">
				<div className="shimmer-surface mb-8 h-8 w-48 rounded-lg" />
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
			<div className="mx-auto w-full max-w-5xl px-6 pt-12 sm:px-10">
				<h2 className="text-lg font-semibold text-destructive">{error}</h2>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-5xl px-6 pt-12 sm:px-10">
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

			<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
									<Thumb
										alt={item.title}
										className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
										loading="lazy"
										src={item.thumbnail}
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
			Library
		</button>
	);
}
