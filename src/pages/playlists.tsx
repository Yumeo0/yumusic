import { Menu } from "@base-ui/react/menu";
import {
	ArrowLeftIcon,
	ArrowUpDown,
	ArrowUpRight,
	Check,
	Download,
	Ellipsis,
	Loader2,
	Music2,
	Pencil,
	Pin,
	Play,
	RefreshCw,
	Search,
	Share2,
	Shuffle,
	Trash2,
	X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PlaylistDownloadOffIcon } from "@/components/downloads/playlist-download-off-icon";
import { EqualizerBars } from "@/components/player/waveform";
import { ConfirmDeletePlaylistDialog } from "@/components/playlist/confirm-delete-playlist-dialog";
import {
	EditPlaylistDialog,
	type PlaylistEditResult,
} from "@/components/playlist/edit-playlist-dialog";
import { PlaylistContextMenu } from "@/components/playlist/playlist-menu";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import { Input } from "@/components/ui/input";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import {
	syncDownloadedPlaylist,
	togglePlaylistDownload,
	useDownloads,
	usePlaylistDownloaded,
} from "@/lib/downloads/downloads";
import { shareLink } from "@/lib/services/share";
import {
	reconcilePinnedPlaylists,
	usePinnedPlaylists,
} from "@/lib/stores/pinned";
import {
	invalidateLibraryCache,
	LIBRARY_CACHE_KEY,
	PLAYLIST_CACHE_PREFIX,
	type PlaylistView,
	patchCachedPlaylistSongs,
	readCache,
	SYNC_INTERVAL_MS,
	subscribeToLibraryChanges,
	writeCache,
} from "@/lib/stores/playlist-cache";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { useDisplayTitle } from "@/lib/utils/title";
import { cn, parseDuration } from "@/lib/utils/utils";
import {
	cleanSubtitle,
	collectionHeader,
	collectSongs,
	isEditablePlaylist,
	mergePlaylistSongs,
	type RowFallback,
} from "@/lib/youtube/playlist-data";
import {
	enrichSongsWithDescriptions,
	enrichSongsWithUploads,
} from "@/lib/youtube/song-description";
import { isAlbumId } from "@/lib/youtube/youtube.utils";
import {
	getAlbum,
	getLibraryPlaylists,
	getPlaylist,
	type LibraryPlaylist,
	loadPlaylistContinuation,
	type Playlist,
	removeSongFromPlaylist,
} from "../lib/youtube/youtube-client";

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
	const [refreshing, setRefreshing] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const [sort, setSort] = useState<PlaylistSort>("newest");
	const displayTitle = useDisplayTitle();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const downloads = useDownloads();
	const [editOpen, setEditOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const downloadJob = downloads.jobs.get(id ?? "");
	const downloaded = usePlaylistDownloaded(id ?? "");
	// Video entries already resolved to their song version while playing.
	const versions = useSongVersionReplacements();
	/** Video id currently playing; prefetch skips it (playback enriches it). */
	const playingId = currentSong?.id;

	// Stable handlers for the memoized track rows: the latest visible list is
	// read through a ref, so row props stay identical across batch appends.
	const visibleRef = useRef<Array<{ song: Song; index: number }>>([]);
	const playQueueRef = useRef(playQueue);
	playQueueRef.current = playQueue;
	const playTrack = useCallback((position: number) => {
		void playQueueRef.current(
			visibleRef.current.map((entry) => entry.song),
			position,
		);
	}, []);

	// ── Background enrichment ────────────────────────────────────
	// Uploader descriptions carry the real song credits ("Singer: X /
	// Song: Y"); they resolve in the background, update the rendered rows and
	// are patched into the playlist cache so the next visit skips the fetch.
	// Uploader-video detection runs alongside it: reuploads (no release) keep
	// their raw titles, which the rows must know about.
	const descriptionCancelRef = useRef<(() => void) | null>(null);
	const uploadCancelRef = useRef<(() => void) | null>(null);
	const pendingSongsRef = useRef(new Map<string, Song>());
	const flushTimerRef = useRef<number | null>(null);

	const flushEnrichedSongs = useCallback(() => {
		flushTimerRef.current = null;
		const pending = pendingSongsRef.current;
		if (!id || pending.size === 0) return;
		patchCachedPlaylistSongs(id, pending);
		pending.clear();
	}, [id]);

	const applyEnrichedSong = useCallback(
		(updated: Song) => {
			setPlaylist((prev) =>
				prev && prev.id === id
					? {
							...prev,
							songs: prev.songs.map((song) =>
								song.id === updated.id ? updated : song,
							),
						}
					: prev,
			);
			// Cache writes are batched: one localStorage write per song
			// would re-serialize the whole playlist on every arrival.
			pendingSongsRef.current.set(updated.id, updated);
			if (flushTimerRef.current === null) {
				flushTimerRef.current = window.setTimeout(flushEnrichedSongs, 1500);
			}
		},
		[id, flushEnrichedSongs],
	);

	const startEnrichment = useCallback(
		(songs: Song[]) => {
			descriptionCancelRef.current?.();
			descriptionCancelRef.current = enrichSongsWithDescriptions(
				songs,
				applyEnrichedSong,
				// Whatever is playing gets its description from the player
				// response; prefetching it here would be a duplicate request.
				playingId ? new Set([playingId]) : undefined,
			);
			uploadCancelRef.current?.();
			uploadCancelRef.current = enrichSongsWithUploads(
				songs,
				applyEnrichedSong,
			);
		},
		[applyEnrichedSong, playingId],
	);

	// Leaving the playlist (or switching to another one) stops the prefetch
	// and flushes whatever resolved so far into the cache.
	useEffect(() => {
		return () => {
			descriptionCancelRef.current?.();
			uploadCancelRef.current?.();
			if (flushTimerRef.current !== null) {
				window.clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
			flushEnrichedSongs();
		};
	}, [flushEnrichedSongs]);

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
			setPlaylist({ ...cached.data, id });
			setLoading(false);
			syncDownloadedPlaylist(id, cached.data.title, cached.data.songs);
			startEnrichment(cached.data.songs);
			return;
		}

		// Content for this id may already be on screen (cached or fetched):
		// keep it visible and merge the fresh tracks into it once they arrive.
		const hasContent = !!cached || playlist?.id === id;
		if (hasContent) {
			setLoading(false);
			setRefreshing(true);
		} else {
			setLoading(true);
		}
		if (cached) {
			setPlaylist((prev) => (prev?.id === id ? prev : { ...cached.data, id }));
		}

		try {
			setError(null);
			const albumMode = isAlbumId(id);
			const data = albumMode ? await getAlbum(id) : await getPlaylist(id);

			if (!data) {
				if (hasContent) {
					showToast("Could not refresh playlist");
				} else {
					setError(
						albumMode ? "Failed to load album." : "Failed to load playlist.",
					);
				}
				return;
			}

			const header = collectionHeader(data.header);
			const items = "items" in data ? (data.items ?? []) : data.contents;
			const rowFallback: RowFallback = {
				artists: albumMode ? header.artists : undefined,
				thumbnail: header.thumbnail,
			};
			const view: PlaylistView = {
				id,
				title: header.title,
				subtitle: cleanSubtitle(header.subtitle),
				thumbnail: header.thumbnail,
				songs: collectSongs(items, rowFallback),
				complete: !("has_continuation" in data && data.has_continuation),
				editable: !albumMode && isEditablePlaylist(data),
			};
			// With content already on screen (stale cache or a force refresh),
			// applying the first page would shrink the list to it until the
			// continuation pages catch up — a refresh visibly flashed partial
			// song counts. Keep the old list and swap it in once the pass ends.
			if (!hasContent) {
				setPlaylist(view);
			}
			setLoading(false);

			// Load remaining pages, appending as they arrive (playlists only —
			// albums fit in a single response). Only the new batch is applied:
			// re-diffing the whole list on every page made big playlists stutter.
			if ("has_continuation" in data && data.has_continuation) {
				setLoadingMore(true);
				let current: Playlist = data;
				while (current.has_continuation) {
					const continuation = await loadPlaylistContinuation(current);
					if (!continuation) break;
					current = continuation;
					const batch = collectSongs(current.items ?? [], rowFallback);
					view.songs = [...view.songs, ...batch];
					if (!hasContent) {
						setPlaylist((prev) =>
							prev?.id === id
								? { ...view, songs: [...prev.songs, ...batch] }
								: { ...view, songs: [...view.songs] },
						);
					}
				}
				view.complete = !current.has_continuation;
				setLoadingMore(false);
			}

			if (hasContent) {
				// The refresh pass finished: apply the fresh list, keeping the
				// previous row objects where nothing changed.
				setPlaylist((prev) =>
					prev?.id === id
						? { ...view, songs: mergePlaylistSongs(prev.songs, view.songs) }
						: view,
				);
			}

			// Resolve real titles/artists from uploader descriptions in the
			// background (updates the rendered list and the cache).
			startEnrichment(view.songs);
			// A kept-downloaded playlist picks up newly added songs here.
			syncDownloadedPlaylist(id, view.title, view.songs);
			// Never downgrade a complete cache to a partial one: when the
			// continuation pass broke, the previous full list is more useful
			// (and it keeps the cache usable on the next visit).
			if (view.complete || !cached?.data.complete) {
				writeCache(cacheKey, view);
			}
		} catch (err) {
			console.error("Error fetching playlist:", err);
			// Whatever is already on screen beats an error screen
			if (hasContent) {
				showToast("Could not refresh playlist");
			} else {
				setError("Failed to load playlist.");
			}
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchPlaylist changes on every re-render and should not be used as a hook dependency.
	useEffect(() => {
		fetchPlaylist();
		setSearch("");
	}, [id]);

	// The pinned sidebar entry stores its cover from pin time; refresh it
	// whenever this page has fresher metadata (cached or fetched) so a dead
	// or outdated URL heals even for playlists that aren't in the library.
	useEffect(() => {
		if (!id || !playlist) return;
		reconcilePinnedPlaylists([
			{ id, title: playlist.title, thumbnail: playlist.thumbnail },
		]);
	}, [id, playlist]);

	// Return to wherever the user came from (home, search, an artist, another
	// playlist…), not a fixed destination.
	const onBack = () => navigate(-1);

	const sharePlaylist = () => {
		if (!playlist) return;
		const rawId = id?.startsWith("VL") ? id.slice(2) : id;
		void shareLink({
			title: playlist.title,
			url: `https://music.youtube.com/playlist?list=${rawId}`,
		});
	};

	/**
	 * Removes one playlist entry. The row index keeps a duplicated video from
	 * clearing every occurrence locally; the server removes the entry matched
	 * by its set-video id.
	 */
	const removeSong = useCallback(
		async (song: Song, index: number) => {
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
		},
		[id],
	);

	/** Applies a saved edit to the header and its cache entry. */
	const onEditSaved = (result: PlaylistEditResult) => {
		const renamed = result.title !== playlist?.title;
		setPlaylist((prev) => {
			if (!prev) return prev;
			const next = {
				...prev,
				title: result.title,
				thumbnail: result.thumbnail,
			};
			writeCache(PLAYLIST_CACHE_PREFIX + (id ?? ""), next);
			return next;
		});
		// The library list stores the old name; drop it so the next visit
		// refetches and reconciles pinned sidebar titles.
		if (renamed) invalidateLibraryCache();
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
	// Stable row identity: the same track occurrence keeps its key across
	// refetches, so an added/removed track doesn't remount the others.
	const rowKeys = (() => {
		const occurrence = new Map<string, number>();
		return visible.map(({ song }) => {
			const count = occurrence.get(song.id) ?? 0;
			occurrence.set(song.id, count + 1);
			return `${song.id}#${count}`;
		});
	})();
	visibleRef.current = visible;
	/** Display order for "Play all", including rows hidden by the search. */
	const playOrder = ordered.map((entry) => entry.song);
	const activeSort =
		PLAYLIST_SORTS.find((option) => option.value === sort)?.label ??
		"Newest first";

	return (
		<div className="mx-auto w-full max-w-7xl px-6 pt-6 sm:px-10 sm:pt-10">
			<div className="flex items-center justify-between">
				<BackButton onClick={onBack} />
				<div className="flex items-center gap-1">
					{downloadJob ? (
						<button
							className="grid size-9 place-items-center rounded-full text-muted-foreground"
							disabled
							title={
								downloadJob.total > 0
									? `Downloading ${downloadJob.done}/${downloadJob.total}`
									: "Preparing download…"
							}
							type="button"
						>
							<Loader2 className="size-4 animate-spin" />
						</button>
					) : (
						<button
							className={cn(
								"grid size-9 place-items-center rounded-full transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground",
								downloaded ? "text-primary" : "text-muted-foreground",
							)}
							onClick={() =>
								togglePlaylistDownload(
									id ?? "",
									playlist.title,
									loadingMore ? undefined : songs,
								)
							}
							title={
								downloaded
									? "Stop keeping downloaded"
									: isAlbumId(id ?? "")
										? "Download album"
										: "Download playlist"
							}
							type="button"
						>
							{downloaded ? (
								<PlaylistDownloadOffIcon className="size-4" />
							) : (
								<Download className="size-4" />
							)}
						</button>
					)}
					<button
						className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
						disabled={refreshing}
						onClick={() => fetchPlaylist(true)}
						title="Refresh playlist"
						type="button"
					>
						<RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
					</button>
				</div>
			</div>

			{/* Header — cover on top, identity + icon actions below, centered */}
			<PlaylistContextMenu
				highlight={false}
				isPinned={isPinned(id ?? "")}
				onDeleted={() => navigate("/playlists")}
				onEdit={playlist.editable ? () => setEditOpen(true) : undefined}
				onTogglePinned={() =>
					togglePinned({
						id: id ?? "",
						thumbnail: playlist.thumbnail,
						title: playlist.title,
					})
				}
				playlist={{
					id: id ?? "",
					thumbnail: playlist.thumbnail,
					title: playlist.title,
				}}
				songs={songs}
			>
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
						<button
							aria-label="Shuffle play"
							className="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
							disabled={songs.length === 0}
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
						<Menu.Root>
							<Menu.Trigger
								aria-label="More options"
								className="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 data-popup-open:border-primary/40 data-popup-open:text-primary"
								title="More options"
							>
								<Ellipsis className="size-5" />
							</Menu.Trigger>
							<Menu.Portal>
								<Menu.Positioner
									align="end"
									className="z-90 outline-none"
									sideOffset={8}
								>
									<Menu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
										{playlist.editable && (
											<Menu.Item
												className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
												onClick={() => setEditOpen(true)}
											>
												<Pencil className="size-4 text-muted-foreground" />
												Edit playlist
											</Menu.Item>
										)}
										<Menu.Item
											className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
											onClick={sharePlaylist}
										>
											<Share2 className="size-4 text-muted-foreground" />
											Share playlist
										</Menu.Item>
										{!isAlbumId(id ?? "") && (
											<>
												<Menu.Separator className="my-1 h-px bg-foreground/8" />
												<Menu.Item
													className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
													onClick={() => setDeleteOpen(true)}
												>
													<Trash2 className="size-4 text-muted-foreground" />
													Delete playlist
												</Menu.Item>
											</>
										)}
									</Menu.Popup>
								</Menu.Positioner>
							</Menu.Portal>
						</Menu.Root>
					</div>
				</header>
			</PlaylistContextMenu>

			{/* Tracklist — edge-to-edge on mobile */}
			<div className="mt-8 space-y-0.5 pb-4 -mx-6 sm:mx-0">
				{loadingMore && (
					<p className="mb-2 flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground sm:px-0">
						<EqualizerBars className="size-3 text-primary" />
						Loading more…
					</p>
				)}
				{visible.map(({ song, index }, i) => {
					// The row displays the album track when the video was
					// resolved to one; removal and playlist edits stay keyed
					// to the playlist's own entry.
					const displaySong = versions.get(song.id) ?? song;
					return (
						<PlaylistTrackRow
							displaySong={displaySong}
							editable={playlist.editable}
							index={index}
							isCurrent={currentSong?.id === displaySong.id}
							isPlaying={currentSong?.id === displaySong.id && isPlaying}
							key={rowKeys[i]}
							number={sort === "newest" ? index + 1 : i + 1}
							onPlay={playTrack}
							onQueue={addToQueue}
							onRemove={playlist.editable ? removeSong : undefined}
							position={i}
							song={song}
						/>
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

			<EditPlaylistDialog
				currentThumbnail={playlist.thumbnail}
				currentTitle={playlist.title}
				onOpenChange={setEditOpen}
				onSaved={onEditSaved}
				open={editOpen}
				playlistId={id ?? null}
			/>
			<ConfirmDeletePlaylistDialog
				isPinned={isPinned(id ?? "")}
				onDeleted={() => navigate("/playlists")}
				onOpenChange={setDeleteOpen}
				onTogglePinned={() =>
					togglePinned({
						id: id ?? "",
						thumbnail: playlist.thumbnail,
						title: playlist.title,
					})
				}
				open={deleteOpen}
				playlistId={id ?? ""}
				playlistTitle={playlist.title}
			/>
		</div>
	);
}

/**
 * One tracklist row. Memoized on stable props so appending a fetched batch
 * only renders the new rows, not the whole (often long) list.
 */
const PlaylistTrackRow = memo(function PlaylistTrackRow({
	song,
	displaySong,
	position,
	index,
	number,
	isCurrent,
	isPlaying,
	editable,
	onPlay,
	onQueue,
	onRemove,
}: {
	/** The playlist's own entry, used when removing it. */
	song: Song;
	/** The song as shown and queued: its album track, when one was resolved. */
	displaySong: Song;
	/** Display position, used to start playback at this row. */
	position: number;
	/** Playlist position, used when removing this entry. */
	index: number;
	number: number;
	isCurrent: boolean;
	isPlaying: boolean;
	editable: boolean;
	onPlay: (position: number) => void;
	onQueue: (songs: Song[]) => void;
	onRemove?: (song: Song, index: number) => void;
}) {
	return (
		<SongContextMenu
			onRemove={editable && onRemove ? () => onRemove(song, index) : undefined}
			song={displaySong}
		>
			<SwipeToQueue onQueue={() => onQueue([displaySong])}>
				<button
					className={cn(
						"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors duration-150 hover:bg-foreground/5 sm:px-2.5",
						isCurrent && "bg-primary/8",
					)}
					onClick={() => onPlay(position)}
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
									{number}
								</span>
								<Play className="absolute size-3.5 fill-current scale-75 text-foreground opacity-0 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100" />
							</>
						)}
					</span>

					{/* Thumbnail */}
					{displaySong.thumbnail ? (
						<img
							alt={displaySong.title}
							className="size-10 rounded-md border border-foreground/10 object-cover"
							loading="lazy"
							src={proxiedImageUrl(displaySong.thumbnail)}
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
							<SongTitle
								artist={displaySong.artist}
								keepTitle={displaySong.upload}
								title={displaySong.title}
							/>
						</h3>
						<p className="truncate text-xs text-muted-foreground">
							<ArtistLinks song={displaySong} />
						</p>
					</div>

					{/* Downloaded marker + duration */}
					<div className="flex items-center gap-2 pr-2">
						<DownloadedBadge songId={displaySong.id} />
						<span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
							{displaySong.duration}
						</span>
					</div>
				</button>
			</SwipeToQueue>
		</SongContextMenu>
	);
});

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
			reconcilePinnedPlaylists(list);
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

	// A playlist was created (or the library otherwise changed) elsewhere:
	// bypass the cache and refresh the grid in place.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchPlaylists changes on every re-render and should not be used as a hook dependency.
	useEffect(
		() => subscribeToLibraryChanges(() => void fetchPlaylists(true)),
		[],
	);

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
					<PlaylistContextMenu
						isPinned={isPinned(item.id)}
						key={item.id}
						onDeleted={() =>
							setPlaylists((prev) =>
								prev.filter((playlist) => playlist.id !== item.id),
							)
						}
						onTogglePinned={() =>
							togglePinned({
								id: item.id,
								thumbnail: item.thumbnail,
								title: item.title,
							})
						}
						playlist={item}
					>
						<div
							className="group animate-track-in relative rounded-xl"
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
									className={cn(
										"size-3.5",
										isPinned(item.id) && "fill-current",
									)}
								/>
							</button>
						</div>
					</PlaylistContextMenu>
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
