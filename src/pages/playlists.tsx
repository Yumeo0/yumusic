import { DropdownMenu } from "@kobalte/core/dropdown-menu";
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
} from "@lucide/solid";
import { useNavigate, useParams } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onSettled,
	Show,
	untrack,
} from "solid-js";
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
import { createVirtualizer, findScrollParent } from "@/lib/utils/virtual";
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

/** One tracklist row: the playlist's own entry plus the stable row key. */
type TrackEntry = { index: number; song: Song; key: string };

export function PlaylistDetails() {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();
	const player = usePlayer();
	const controls = usePlayerControls();
	const [playlist, setPlaylist] = createSignal<PlaylistView | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [refreshing, setRefreshing] = createSignal(false);
	const [loadingMore, setLoadingMore] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [search, setSearch] = createSignal("");
	const [searchOpen, setSearchOpen] = createSignal(false);
	const [sort, setSort] = createSignal<PlaylistSort>("newest");
	const displayTitle = useDisplayTitle();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const downloads = useDownloads();
	const [editOpen, setEditOpen] = createSignal(false);
	const [deleteOpen, setDeleteOpen] = createSignal(false);
	const downloadJob = () => downloads.jobs.get(params.id ?? "");
	const downloaded = usePlaylistDownloaded(() => params.id ?? "");
	// Video entries already resolved to their song version while playing.
	const versions = useSongVersionReplacements();

	// Stable handler for the track rows: the latest visible list is read at
	// call time, so rows don't depend on the list identity.
	const playTrack = (position: number) => {
		void player.playQueue(
			visibleList().map((entry) => entry.song),
			position,
		);
	};

	// ── Background enrichment ────────────────────────────────────
	// Uploader descriptions carry the real song credits ("Singer: X /
	// Song: Y"); they resolve in the background, update the rendered rows and
	// are patched into the playlist cache so the next visit skips the fetch.
	// Uploader-video detection runs alongside it: reuploads (no release) keep
	// their raw titles, which the rows must know about.
	let descriptionCancel: (() => void) | null = null;
	let uploadCancel: (() => void) | null = null;
	const pendingSongs = new Map<string, Song>();
	let flushTimer: number | null = null;

	const flushEnrichedSongs = (id: string | undefined = params.id) => {
		flushTimer = null;
		if (!id || pendingSongs.size === 0) return;
		patchCachedPlaylistSongs(id, pendingSongs);
		pendingSongs.clear();
	};

	const applyEnrichedSong = (updated: Song) => {
		const id = params.id;
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
		pendingSongs.set(updated.id, updated);
		if (flushTimer === null) {
			flushTimer = window.setTimeout(flushEnrichedSongs, 1500);
		}
	};

	const startEnrichment = (songs: Song[]) => {
		descriptionCancel?.();
		// Snapshot at call time (deliberately untracked): whatever is playing
		// gets its description from the player response, so prefetching it
		// here would be a duplicate request.
		const playingId = untrack(player.currentSong)?.id;
		descriptionCancel = enrichSongsWithDescriptions(
			songs,
			applyEnrichedSong,
			playingId ? new Set([playingId]) : undefined,
		);
		uploadCancel?.();
		uploadCancel = enrichSongsWithUploads(songs, applyEnrichedSong);
	};

	// Leaving the playlist (or switching to another one) stops the prefetch
	// and flushes whatever resolved so far into the cache.
	createEffect(
		() => params.id,
		(id) => {
			return () => {
				descriptionCancel?.();
				uploadCancel?.();
				if (flushTimer !== null) {
					window.clearTimeout(flushTimer);
					flushTimer = null;
				}
				flushEnrichedSongs(id);
			};
		},
	);

	const loadPlaylist = async (id: string | undefined, force: boolean) => {
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
		const hasContent = !!cached || playlist()?.id === id;
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

	createEffect(
		() => params.id,
		(id) => {
			void loadPlaylist(id, false);
			setSearch("");
		},
	);

	// The pinned sidebar entry stores its cover from pin time; refresh it
	// whenever this page has fresher metadata (cached or fetched) so a dead
	// or outdated URL heals even for playlists that aren't in the library.
	createEffect(
		() => ({ id: params.id, playlist: playlist() }),
		({ id, playlist: current }) => {
			if (!id || !current) return;
			reconcilePinnedPlaylists([
				{ id, title: current.title, thumbnail: current.thumbnail },
			]);
		},
	);

	// Return to wherever the user came from (home, search, an artist, another
	// playlist…), not a fixed destination.
	const onBack = () => navigate(-1);

	const sharePlaylist = () => {
		const current = playlist();
		const id = params.id;
		if (!current) return;
		const rawId = id?.startsWith("VL") ? id.slice(2) : id;
		void shareLink({
			title: current.title,
			url: `https://music.youtube.com/playlist?list=${rawId}`,
		});
	};

	/**
	 * Removes one playlist entry. The row index keeps a duplicated video from
	 * clearing every occurrence locally; the server removes the entry matched
	 * by its set-video id.
	 */
	const removeSong = async (song: Song, index: number) => {
		const id = params.id;
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
		} catch (err) {
			console.error("[YuMusic] remove from playlist failed:", err);
			showToast("Could not remove from playlist");
		}
	};

	/** Applies a saved edit to the header and its cache entry. */
	const onEditSaved = (result: PlaylistEditResult) => {
		const renamed = result.title !== playlist()?.title;
		setPlaylist((prev) => {
			if (!prev) return prev;
			const next = {
				...prev,
				title: result.title,
				thumbnail: result.thumbnail,
			};
			writeCache(PLAYLIST_CACHE_PREFIX + (params.id ?? ""), next);
			return next;
		});
		// The library list stores the old name; drop it so the next visit
		// refetches and reconciles pinned sidebar titles.
		if (renamed) invalidateLibraryCache();
	};

	// Search filter — matches titles and artist names. Rows keep their original
	// playlist position for numbering unless a sort is active. YouTube Music
	// returns a playlist newest-first (new additions land at the top), so
	// "newest" needs no work and "oldest" reverses it. Ties keep that order.
	//
	// Entries are cached by row key so that a recompute reuses the objects
	// whose data didn't change — virtualized rows (and their menus) only
	// remount for the tracks that actually changed.
	let entryCache = new Map<string, TrackEntry>();
	const orderedList = createMemo(() => {
		const list = (playlist()?.songs ?? []).map((song, index) => ({
			index,
			song,
		}));
		const mode = sort();
		if (mode !== "newest") {
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
			list.sort((a, b) => {
				let result = 0;
				switch (mode) {
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
		// Stable row identity: the same track occurrence keeps its key across
		// refetches, so an added/removed track doesn't remount the others —
		// and an entry whose data didn't change keeps its object identity, so
		// a refresh of one song doesn't remount the other virtualized rows.
		const occurrence = new Map<string, number>();
		const nextCache = new Map<string, TrackEntry>();
		const entries = list.map((entry) => {
			const count = occurrence.get(entry.song.id) ?? 0;
			occurrence.set(entry.song.id, count + 1);
			const key = `${entry.song.id}#${count}`;
			const previous = entryCache.get(key);
			const next =
				previous?.song === entry.song && previous.index === entry.index
					? previous
					: { ...entry, key };
			nextCache.set(key, next);
			return next;
		});
		entryCache = nextCache;
		return entries;
	});

	const visibleList = createMemo(() => {
		const query = search().trim().toLowerCase();
		return orderedList().filter(({ song }) => {
			if (!query) return true;
			return [
				song.title,
				song.artist,
				...(song.artists ?? []).map((a) => a.name),
			]
				.filter(Boolean)
				.some((text) => text.toLowerCase().includes(query));
		});
	});

	// ── Tracklist virtualization ─────────────────────────────────
	// Playlists can hold thousands of tracks and every row carries a Kobalte
	// context menu, so only the rows near the viewport are rendered. The list
	// scrolls with the page, so the virtualizer needs the list's offset
	// inside the shell's scroll container (`scrollMargin`) to know what's
	// visible; the offset is re-measured after the first layout.
	const [scrollMargin, setScrollMargin] = createSignal(0);
	const [scrollParent, setScrollParent] = createSignal<HTMLElement | null>(
		null,
	);
	let tracklistEl: HTMLDivElement | undefined;

	const measureScrollMargin = () => {
		const list = tracklistEl;
		const container = scrollParent();
		if (!list?.isConnected || !container) return;
		setScrollMargin(
			list.getBoundingClientRect().top -
				container.getBoundingClientRect().top +
				container.scrollTop,
		);
	};

	const rowVirtualizer = createVirtualizer<HTMLElement, HTMLDivElement>(() => {
		// Reading the scroller here keeps the options effect in touch with it:
		// the adapter re-runs `_willUpdate` whenever the options change, which
		// is what attaches the scroll/rect observers to a late-resolved
		// element (refs run before the rendered tree is in the document).
		const container = scrollParent();
		return {
			count: visibleList().length,
			// Row height plus the 2px gap the rows are spaced with.
			estimateSize: () => 58,
			getScrollElement: () => container,
			// A revisit can mount while the shell is still scrolled; start
			// from the container's actual position instead of the top.
			initialOffset: () => container?.scrollTop ?? 0,
			measureElement: (element) =>
				Math.round(element.getBoundingClientRect().height) + 2,
			overscan: 8,
			scrollMargin: scrollMargin(),
		};
	});

	onSettled(() => {
		measureScrollMargin();
	});

	/** Display order for "Play all", including rows hidden by the search. */
	const playOrder = () => orderedList().map((entry) => entry.song);
	const activeSort = () =>
		PLAYLIST_SORTS.find((option) => option.value === sort())?.label ??
		"Newest first";

	return (
		<Show
			fallback={
				<div class="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
					<div class="shimmer-surface h-9 w-24 rounded-full" />
					<div class="mt-8 flex gap-6">
						<div class="shimmer-surface size-44 rounded-xl" />
						<div class="flex flex-1 flex-col justify-end gap-3 pb-2">
							<div class="shimmer-surface h-10 w-2/3 rounded-lg" />
							<div class="shimmer-surface h-3.5 w-40 rounded-md" />
						</div>
					</div>
					<div class="mt-10 space-y-2">
						<For each={[1, 2, 3, 4, 5, 6]}>
							{() => <div class="shimmer-surface h-14 rounded-lg" />}
						</For>
					</div>
				</div>
			}
			when={!loading()}
		>
			<Show
				fallback={
					<div class="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
						<BackButton onClick={onBack} />
						<h2 class="mt-8 text-lg font-semibold text-destructive">
							{error() || "Playlist not found."}
						</h2>
					</div>
				}
				when={error() ? null : playlist()}
			>
				{(view) => {
					const songs = () => view().songs;
					const showCount = () =>
						songs().length > 0 && !/\d+\s+songs?\b/i.test(view().subtitle);
					return (
						<div class="mx-auto w-full max-w-7xl px-6 pt-6 sm:px-10 sm:pt-10">
							<div class="flex items-center justify-between">
								<BackButton onClick={onBack} />
								<div class="flex items-center gap-1">
									<Show
										fallback={
											<button
												class={cn(
													"grid size-9 place-items-center rounded-full transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground",
													downloaded()
														? "text-primary"
														: "text-muted-foreground",
												)}
												onClick={() =>
													togglePlaylistDownload(
														params.id ?? "",
														view().title,
														loadingMore() ? undefined : songs(),
													)
												}
												title={
													downloaded()
														? "Stop keeping downloaded"
														: isAlbumId(params.id ?? "")
															? "Download album"
															: "Download playlist"
												}
												type="button"
											>
												<Show
													fallback={<Download class="size-4" />}
													when={downloaded()}
												>
													<PlaylistDownloadOffIcon class="size-4" />
												</Show>
											</button>
										}
										when={downloadJob()}
									>
										{(job) => (
											<button
												class="grid size-9 place-items-center rounded-full text-muted-foreground"
												disabled
												title={
													job().total > 0
														? `Downloading ${job().done}/${job().total}`
														: "Preparing download…"
												}
												type="button"
											>
												<Loader2 class="size-4 animate-spin" />
											</button>
										)}
									</Show>
									<button
										class="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
										disabled={refreshing()}
										onClick={() => void loadPlaylist(params.id, true)}
										title="Refresh playlist"
										type="button"
									>
										<RefreshCw
											class={cn("size-4", refreshing() && "animate-spin")}
										/>
									</button>
								</div>
							</div>

							{/* Header — cover on top, identity + icon actions below, centered */}
							<PlaylistContextMenu
								highlight={false}
								isPinned={isPinned(params.id ?? "")}
								onDeleted={() => navigate("/playlists")}
								onEdit={view().editable ? () => setEditOpen(true) : undefined}
								onTogglePinned={() =>
									togglePinned({
										id: params.id ?? "",
										thumbnail: view().thumbnail,
										title: view().title,
									})
								}
								playlist={{
									id: params.id ?? "",
									thumbnail: view().thumbnail,
									title: view().title,
								}}
								songs={songs()}
							>
								<header class="animate-track-in mt-4 text-center sm:mt-6">
									<Show
										fallback={
											<div class="mx-auto grid size-36 place-items-center rounded-xl border border-foreground/10 bg-card sm:size-40">
												<Music2 class="size-10 text-muted-foreground" />
											</div>
										}
										when={view().thumbnail}
									>
										{(thumbnail) => (
											<img
												alt={view().title}
												class="mx-auto size-36 rounded-xl border border-foreground/10 object-cover sm:size-40"
												loading="lazy"
												src={proxiedImageUrl(thumbnail())}
											/>
										)}
									</Show>
									<h1 class="mt-4 truncate text-3xl font-bold tracking-tight sm:text-4xl">
										{view().title}
									</h1>
									<p class="mt-2 text-sm text-muted-foreground">
										{[
											view().subtitle,
											showCount()
												? `${songs().length} ${songs().length === 1 ? "track" : "tracks"}`
												: "",
										]
											.filter(Boolean)
											.join(" · ")}
									</p>
									<div class="mt-4 flex items-center justify-center gap-2">
										<DropdownMenu>
											<DropdownMenu.Trigger
												aria-label={`Sort playlist (${activeSort()})`}
												class="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 data-[expanded]:border-primary/40 data-[expanded]:text-primary"
												title={`Sort: ${activeSort()}`}
											>
												<ArrowUpDown class="size-5" />
											</DropdownMenu.Trigger>
											<DropdownMenu.Portal>
												<DropdownMenu.Content class="z-90 min-w-44 rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-[closed]:scale-95 data-[closed]:opacity-0">
													<DropdownMenu.RadioGroup
														onChange={(value) => setSort(value as PlaylistSort)}
														value={sort()}
													>
														<For each={PLAYLIST_SORTS}>
															{(option) => (
																<DropdownMenu.RadioItem
																	class="flex cursor-default items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
																	value={option.value}
																>
																	{option.label}
																	<DropdownMenu.ItemIndicator class="text-primary">
																		<Check class="size-4" />
																	</DropdownMenu.ItemIndicator>
																</DropdownMenu.RadioItem>
															)}
														</For>
													</DropdownMenu.RadioGroup>
												</DropdownMenu.Content>
											</DropdownMenu.Portal>
										</DropdownMenu>
										<button
											aria-label="Shuffle play"
											class="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:pointer-events-none disabled:opacity-40"
											disabled={songs().length === 0}
											onClick={() => {
												const shuffled = [...songs()];
												for (let i = shuffled.length - 1; i > 0; i--) {
													const j = Math.floor(Math.random() * (i + 1));
													[shuffled[i], shuffled[j]] = [
														shuffled[j],
														shuffled[i],
													];
												}
												void player.play(shuffled[0], shuffled.slice(1));
											}}
											title="Shuffle play"
											type="button"
										>
											<Shuffle class="size-5" />
										</button>
										<button
											aria-label="Play all"
											class="grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_16px_-4px_color-mix(in_oklab,var(--primary)_60%,transparent)] transition-all duration-200 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
											disabled={songs().length === 0}
											onClick={() => {
												const order = playOrder();
												void player.play(order[0], order.slice(1));
											}}
											title="Play all"
											type="button"
										>
											<Play class="size-5 translate-x-px fill-current" />
										</button>
										<Show when={songs().length > 0}>
											<Show
												fallback={
													<button
														aria-label="Search in playlist"
														class="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95"
														onClick={() => setSearchOpen(true)}
														title="Search in playlist"
														type="button"
													>
														<Search class="size-5" />
													</button>
												}
												when={searchOpen()}
											>
												<div class="relative w-64">
													<Search class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
													<Input
														autofocus
														class="h-11 rounded-full pr-8 pl-9"
														onInput={(event) => {
															setSearch(event.target.value);
														}}
														placeholder="Search in playlist"
														value={search()}
													/>
													<button
														aria-label={
															search() ? "Clear search" : "Close search"
														}
														class="absolute top-1/2 right-2 -translate-y-1/2 grid size-6 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
														onClick={() => {
															if (search()) {
																setSearch("");
															} else {
																setSearchOpen(false);
															}
														}}
														type="button"
													>
														<X class="size-4" />
													</button>
												</div>
											</Show>
										</Show>
										<DropdownMenu>
											<DropdownMenu.Trigger
												aria-label="More options"
												class="grid size-11 place-items-center rounded-full border border-foreground/12 transition-all duration-200 hover:border-primary/40 hover:text-primary active:scale-95 data-[expanded]:border-primary/40 data-[expanded]:text-primary"
												title="More options"
											>
												<Ellipsis class="size-5" />
											</DropdownMenu.Trigger>
											<DropdownMenu.Portal>
												<DropdownMenu.Content class="z-90 min-w-44 rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-[closed]:scale-95 data-[closed]:opacity-0">
													<Show when={view().editable}>
														<DropdownMenu.Item
															class="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
															onClick={() => setEditOpen(true)}
														>
															<Pencil class="size-4 text-muted-foreground" />
															Edit playlist
														</DropdownMenu.Item>
													</Show>
													<DropdownMenu.Item
														class="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
														onClick={sharePlaylist}
													>
														<Share2 class="size-4 text-muted-foreground" />
														Share playlist
													</DropdownMenu.Item>
													<Show when={!isAlbumId(params.id ?? "")}>
														<DropdownMenu.Separator class="my-1 h-px bg-foreground/8" />
														<DropdownMenu.Item
															class="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
															onClick={() => setDeleteOpen(true)}
														>
															<Trash2 class="size-4 text-muted-foreground" />
															Delete playlist
														</DropdownMenu.Item>
													</Show>
												</DropdownMenu.Content>
											</DropdownMenu.Portal>
										</DropdownMenu>
									</div>
								</header>
							</PlaylistContextMenu>

							{/* Tracklist — only the rows near the viewport render;
							    edge-to-edge on mobile */}
							<div class="mt-8 -mx-6 pb-4 sm:mx-0">
								<Show when={loadingMore()}>
									<p class="mb-2 flex items-center gap-2 px-4 py-1 text-xs text-muted-foreground sm:px-0">
										<EqualizerBars class="size-3 text-primary" />
										Loading more…
									</p>
								</Show>
								<div
									class="relative"
									ref={(el) => {
										tracklistEl = el;
										// Refs run while the template is still detached, so
										// the scrollable ancestor and the list's offset only
										// resolve once the element is in the document —
										// after this render pass.
										queueMicrotask(() => {
											setScrollParent(
												findScrollParent(el) ?? document.documentElement,
											);
											measureScrollMargin();
										});
									}}
									style={{ height: `${rowVirtualizer.totalSize()}px` }}
								>
									<For
										each={rowVirtualizer.virtualItems()}
										keyed={(row) => row.key}
									>
										{(vrow) => {
											// Guarded by the Show below: a shrinking list can
											// briefly leave a row pointing past the end.
											const entry = () => visibleList()[vrow().index];
											return (
												<div
													class="absolute inset-x-0 top-0"
													ref={(el) => {
														// Deliberate snapshot: the row's virtual index is
														// fixed for the row's lifetime (the list is keyed
														// by it) and refs run outside any tracking scope.
														rowVirtualizer.measureRow(el, untrack(vrow).index);
													}}
													style={{
														transform: `translateY(${vrow().start - scrollMargin()}px)`,
													}}
												>
													<Show when={entry()}>
														{(current) => {
															// The row displays the album track when the
															// video was resolved to one; removal and
															// playlist edits stay keyed to the playlist's
															// own entry.
															const displaySong = () =>
																versions.get(current().song.id) ??
																current().song;
															const isCurrent = () =>
																player.currentSong()?.id === displaySong().id;
															return (
																<PlaylistTrackRow
																	displaySong={displaySong()}
																	editable={view().editable}
																	index={current().index}
																	isCurrent={isCurrent()}
																	isPlaying={
																		isCurrent() && controls.isPlaying()
																	}
																	number={
																		sort() === "newest"
																			? current().index + 1
																			: vrow().index + 1
																	}
																	onPlay={playTrack}
																	onQueue={(queued) =>
																		player.addToQueue(queued)
																	}
																	onRemove={
																		view().editable
																			? (removed) =>
																					void removeSong(
																						removed,
																						current().index,
																					)
																			: undefined
																	}
																	position={vrow().index}
																	song={current().song}
																/>
															);
														}}
													</Show>
												</div>
											);
										}}
									</For>
								</div>
								<Show
									when={
										visibleList().length === 0 &&
										search().trim() &&
										songs().length > 0
									}
								>
									<p class="px-4 py-10 text-sm text-muted-foreground sm:px-0">
										No tracks match "{search().trim()}".
									</p>
								</Show>
								<Show when={songs().length === 0}>
									<p class="px-4 py-10 text-sm text-muted-foreground sm:px-0">
										This playlist is empty.
									</p>
								</Show>
							</div>

							<EditPlaylistDialog
								currentThumbnail={view().thumbnail}
								currentTitle={view().title}
								onOpenChange={setEditOpen}
								onSaved={onEditSaved}
								open={editOpen()}
								playlistId={params.id ?? null}
							/>
							<ConfirmDeletePlaylistDialog
								isPinned={isPinned(params.id ?? "")}
								onDeleted={() => navigate("/playlists")}
								onOpenChange={setDeleteOpen}
								onTogglePinned={() =>
									togglePinned({
										id: params.id ?? "",
										thumbnail: view().thumbnail,
										title: view().title,
									})
								}
								open={deleteOpen()}
								playlistId={params.id ?? ""}
								playlistTitle={view().title}
							/>
						</div>
					);
				}}
			</Show>
		</Show>
	);
}

/**
 * One tracklist row. Only its own props drive what it renders, so appending a
 * fetched batch doesn't touch the existing rows' DOM.
 */
function PlaylistTrackRow(props: {
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
			onRemove={
				props.editable && props.onRemove
					? () => props.onRemove?.(props.song, props.index)
					: undefined
			}
			song={props.displaySong}
		>
			<SwipeToQueue onQueue={() => props.onQueue([props.displaySong])}>
				<button
					class={cn(
						"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-4 py-2 text-left transition-colors duration-150 hover:bg-foreground/5 sm:px-2.5",
						props.isCurrent && "bg-primary/8",
					)}
					onClick={() => props.onPlay(props.position)}
					type="button"
				>
					{/* Index / play / EQ */}
					<span class="relative grid place-items-center">
						<Show
							fallback={
								<>
									<span class="font-mono text-xs text-muted-foreground/60 transition-opacity duration-150 group-hover:opacity-0">
										{props.number}
									</span>
									<Play class="absolute size-3.5 fill-current scale-75 text-foreground opacity-0 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100" />
								</>
							}
							when={props.isCurrent}
						>
							<EqualizerBars
								class="size-3.5 text-primary"
								playing={props.isPlaying}
							/>
						</Show>
					</span>

					{/* Thumbnail */}
					<Show
						fallback={<div class="size-10 rounded-md bg-muted" />}
						when={props.displaySong.thumbnail}
					>
						{(thumbnail) => (
							<img
								alt={props.displaySong.title}
								class="size-10 rounded-md border border-foreground/10 object-cover"
								loading="lazy"
								src={proxiedImageUrl(thumbnail())}
							/>
						)}
					</Show>

					{/* Title + artists */}
					<div class="min-w-0">
						<h3
							class={cn(
								"truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary",
								props.isCurrent && "text-primary",
							)}
						>
							<SongTitle
								artist={props.displaySong.artist}
								keepTitle={props.displaySong.upload}
								title={props.displaySong.title}
							/>
						</h3>
						<p class="truncate text-xs text-muted-foreground">
							<ArtistLinks song={props.displaySong} />
						</p>
					</div>

					{/* Downloaded marker + duration */}
					<div class="flex items-center gap-2 pr-2">
						<DownloadedBadge songId={props.displaySong.id} />
						<span class="font-mono text-xs text-muted-foreground/70 tabular-nums">
							{props.displaySong.duration}
						</span>
					</div>
				</button>
			</SwipeToQueue>
		</SongContextMenu>
	);
}

export default function PlaylistsPage() {
	const navigate = useNavigate();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const [playlists, setPlaylists] = createSignal<LibraryPlaylist[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);

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

	onSettled(() => {
		void fetchPlaylists();
		// A playlist was created (or the library otherwise changed) elsewhere:
		// bypass the cache and refresh the grid in place.
		const unsubscribe = subscribeToLibraryChanges(
			() => void fetchPlaylists(true),
		);
		return unsubscribe;
	});

	return (
		<Show
			fallback={
				<div class="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
					<div class="shimmer-surface mb-8 h-8 w-48 rounded-lg" />
					<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
						<For each={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}>
							{() => (
								<div>
									<div class="shimmer-surface aspect-square rounded-xl" />
									<div class="shimmer-surface mt-3 h-4 w-3/4 rounded-md" />
								</div>
							)}
						</For>
					</div>
				</div>
			}
			when={!loading()}
		>
			<Show
				fallback={
					<div class="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
						<h2 class="text-lg font-semibold text-destructive">{error()}</h2>
					</div>
				}
				when={!error()}
			>
				<div class="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
					<div class="mb-8 flex items-center justify-between">
						<h1 class="text-2xl font-bold tracking-tight">Playlists</h1>
						<button
							class="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
							disabled={loading()}
							onClick={() => void fetchPlaylists(true)}
							title="Refresh library"
							type="button"
						>
							<RefreshCw class={cn("size-4", loading() && "animate-spin")} />
						</button>
					</div>

					<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
						<For each={playlists()} keyed={(item) => item.id}>
							{(item, index) => (
								<PlaylistContextMenu
									isPinned={isPinned(item().id)}
									onDeleted={() =>
										setPlaylists((prev) =>
											prev.filter((playlist) => playlist.id !== item().id),
										)
									}
									onTogglePinned={() =>
										togglePinned({
											id: item().id,
											thumbnail: item().thumbnail,
											title: item().title,
										})
									}
									playlist={item()}
								>
									<div
										class="group animate-track-in relative rounded-xl"
										style={{
											"animation-delay": `${Math.min(index() * 40, 400)}ms`,
										}}
									>
										<button
											class="block w-full overflow-hidden rounded-xl border border-foreground/8 bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40"
											onClick={() => navigate(`/playlists/${item().id}`)}
											type="button"
										>
											<div class="relative aspect-square overflow-hidden bg-muted">
												<Show
													fallback={
														<div class="grid size-full place-items-center text-muted-foreground">
															<Music2 class="size-8" />
														</div>
													}
													when={item().thumbnail}
												>
													{(thumbnail) => (
														<img
															alt={item().title}
															class="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
															loading="lazy"
															src={proxiedImageUrl(thumbnail())}
														/>
													)}
												</Show>
												<span class="absolute top-2.5 right-2.5 grid size-7 translate-y-1 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
													<ArrowUpRight class="size-3.5" />
												</span>
											</div>
											<div class="p-3.5">
												<h3 class="line-clamp-1 text-sm font-medium transition-colors duration-150 group-hover:text-primary">
													{item().title}
												</h3>
												<p class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
													{item().subtitle}
												</p>
											</div>
										</button>
										<button
											aria-label={
												isPinned(item().id)
													? "Unpin from sidebar"
													: "Pin to sidebar"
											}
											class={cn(
												"absolute top-2.5 left-2.5 grid size-7 -translate-y-1 place-items-center rounded-full backdrop-blur-sm transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100",
												isPinned(item().id)
													? "bg-primary text-primary-foreground opacity-100"
													: "bg-black/55 text-white opacity-0 hover:bg-black/70",
											)}
											onClick={() =>
												togglePinned({
													id: item().id,
													title: item().title,
													thumbnail: item().thumbnail,
												})
											}
											title={
												isPinned(item().id)
													? "Unpin from sidebar"
													: "Pin to sidebar"
											}
											type="button"
										>
											<Pin
												class={cn(
													"size-3.5",
													isPinned(item().id) && "fill-current",
												)}
											/>
										</button>
									</div>
								</PlaylistContextMenu>
							)}
						</For>
					</div>
					<Show when={playlists().length === 0}>
						<p class="py-12 text-sm text-muted-foreground">
							No playlists found in your library yet.
						</p>
					</Show>
				</div>
			</Show>
		</Show>
	);
}

function BackButton(props: { onClick: () => void }) {
	return (
		<button
			class="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
			onClick={props.onClick}
			type="button"
		>
			<span class="grid size-8 place-items-center rounded-full border border-foreground/10 transition-colors group-hover:border-primary/40">
				<ArrowLeftIcon class="size-4" />
			</span>
			Back
		</button>
	);
}
