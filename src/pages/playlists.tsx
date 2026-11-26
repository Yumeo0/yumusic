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
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PlaylistDownloadOffIcon } from "@/components/downloads/playlist-download-off-icon";
import { EqualizerBars } from "@/components/player/waveform";
import { ConfirmDeletePlaylistDialog } from "@/components/playlist/confirm-delete-playlist-dialog";
import { EditPlaylistDialog } from "@/components/playlist/edit-playlist-dialog";
import { PlaylistContextMenu } from "@/components/playlist/playlist-menu";
import { VirtualTrackList } from "@/components/playlist/virtual-track-list";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongRowHover, SongRowRating } from "@/components/song/song-row-hover";
import { SongTitle } from "@/components/song/song-title";
import { Input } from "@/components/ui/input";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import {
	togglePlaylistDownload,
	usePlaylistDownloaded,
	usePlaylistDownloadJob,
} from "@/lib/downloads/downloads";
import type { PlaylistTrack } from "@/lib/music/playlist";
import type { Song } from "@/lib/music/song";
import { shuffleFrom } from "@/lib/player/shuffle";
import { shareLink } from "@/lib/services/share";
import { usePinnedPlaylists } from "@/lib/stores/pinned";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { useDisplayTitle } from "@/lib/utils/use-song-title";
import { cn, parseDuration } from "@/lib/utils/utils";
import { canonicalPlaylistId } from "@/lib/youtube/playlist-id";
import { usePlaylistLibrary } from "@/lib/youtube/use-playlist-library";
import { usePlaylistView } from "@/lib/youtube/use-playlist-view";
import { isAlbumId } from "@/lib/youtube/youtube.utils";

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

const playlistCollator = new Intl.Collator(undefined, { sensitivity: "base" });
const EMPTY_TRACKS: PlaylistTrack[] = [];

interface IndexedTrack {
	song: PlaylistTrack;
	index: number;
	key: string;
}

function indexTracks(songs: PlaylistTrack[]): IndexedTrack[] {
	const occurrences = new Map<string, number>();
	return songs.map((song, index) => {
		if (song.entryId) return { song, index, key: `entry:${song.entryId}` };
		const occurrence = occurrences.get(song.id) ?? 0;
		occurrences.set(song.id, occurrence + 1);
		return { song, index, key: `${song.id}#${occurrence}` };
	});
}

function orderTracks(
	tracks: IndexedTrack[],
	sort: PlaylistSort,
	displayTitle: (title: string) => string,
): IndexedTrack[] {
	if (sort === "newest") return tracks;
	if (sort === "oldest") return [...tracks].reverse();
	if (sort === "shortest" || sort === "longest") {
		const lengths = tracks.map(({ song }) => parseDuration(song.duration));
		const direction = sort === "shortest" ? 1 : -1;
		return [...tracks].sort(
			(a, b) =>
				direction * (lengths[a.index] - lengths[b.index]) || a.index - b.index,
		);
	}
	const byTitle = sort === "title-asc" || sort === "title-desc";
	const names = tracks.map(({ song }) =>
		byTitle ? displayTitle(song.title) : (song.artist ?? ""),
	);
	const direction = sort === "title-asc" || sort === "artist-asc" ? 1 : -1;
	return [...tracks].sort(
		(a, b) =>
			direction * playlistCollator.compare(names[a.index], names[b.index]) ||
			a.index - b.index,
	);
}

export function PlaylistDetails() {
	const { id } = useParams<{ id: string }>();
	const [sort, setSort] = useState<PlaylistSort>("newest");
	const [searchOpen, setSearchOpen] = useState(false);
	return id ? (
		<PlaylistDetailsView
			id={id}
			key={id}
			searchOpen={searchOpen}
			setSearchOpen={setSearchOpen}
			setSort={setSort}
			sort={sort}
		/>
	) : null;
}

function PlaylistDetailsView({
	id,
	searchOpen,
	setSearchOpen,
	setSort,
	sort,
}: {
	id: string;
	searchOpen: boolean;
	setSearchOpen: (open: boolean) => void;
	setSort: (sort: PlaylistSort) => void;
	sort: PlaylistSort;
}) {
	const navigate = useNavigate();
	const { play, playQueue, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const onDelete = useCallback(
		() => navigate("/playlists", { replace: true }),
		[navigate],
	);
	const {
		playlist,
		loading,
		refreshing,
		loadingMore,
		error,
		refresh,
		removeTrack,
	} = usePlaylistView(id, onDelete, currentSong?.id);
	const [search, setSearch] = useState("");
	const displayTitle = useDisplayTitle();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const [editOpen, setEditOpen] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const downloadJob = usePlaylistDownloadJob(id);
	const downloaded = usePlaylistDownloaded(id);
	const versions = useSongVersionReplacements();
	const songs = playlist?.songs ?? EMPTY_TRACKS;
	const tracks = useMemo(() => indexTracks(songs), [songs]);
	const ordered = useMemo(
		() => orderTracks(tracks, sort, displayTitle),
		[tracks, sort, displayTitle],
	);
	const query = search.trim().toLowerCase();
	const visible = useMemo(() => {
		if (!query) return ordered;
		return ordered.filter(({ song }) =>
			[song.title, song.artist, ...(song.artists ?? []).map((a) => a.name)]
				.filter(Boolean)
				.some((text) => text.toLowerCase().includes(query)),
		);
	}, [ordered, query]);
	const getRowKey = useCallback(
		(index: number) => visible[index].key,
		[visible],
	);
	const playOrder = useMemo(
		() => ordered.map((entry) => entry.song),
		[ordered],
	);
	const visiblePlayOrder = useMemo(
		() =>
			visible === ordered ? playOrder : visible.map((entry) => entry.song),
		[ordered, playOrder, visible],
	);

	// Stable handlers for the memoized track rows: the latest visible list is
	// read through a ref, so row props stay identical across batch appends.
	const visibleRef = useRef(visiblePlayOrder);
	visibleRef.current = visiblePlayOrder;
	const playQueueRef = useRef(playQueue);
	playQueueRef.current = playQueue;
	const playTrack = useCallback((position: number) => {
		void playQueueRef.current(visibleRef.current, position);
	}, []);

	const onBack = () => navigate(-1);

	const sharePlaylist = () => {
		if (!playlist) return;
		const rawId = id && canonicalPlaylistId(id);
		void shareLink({
			title: playlist.title,
			url: `https://music.youtube.com/playlist?list=${rawId}`,
		});
	};

	const removeSong = useCallback(
		async (song: PlaylistTrack, index: number) => {
			try {
				await removeTrack(song, index);
				showToast("Removed from playlist");
			} catch (error) {
				console.error("[YuMusic] remove from playlist failed:", error);
				showToast("Could not remove from playlist");
			}
		},
		[removeTrack],
	);

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

	const showCount =
		songs.length > 0 && !/\d+\s+songs?\b/i.test(playlist.subtitle);
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
						onClick={() => void refresh(true)}
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
									<Menu.Popup className="ui-popup min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none">
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
								const shuffled = shuffleFrom(songs, 0);
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
									<Menu.Popup className="ui-popup min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none">
										<Menu.Item
											className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
											onClick={() =>
												id &&
												togglePinned({
													id,
													title: playlist.title,
													thumbnail: playlist.thumbnail,
												})
											}
										>
											<Pin
												className={cn(
													"size-4 text-muted-foreground",
													isPinned(id ?? "") && "fill-current",
												)}
											/>
											{isPinned(id ?? "")
												? "Unpin from sidebar"
												: "Pin to sidebar"}
										</Menu.Item>
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
				<VirtualTrackList count={visible.length} getKey={getRowKey}>
					{(i) => {
						const { song, index, key } = visible[i];
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
								key={key}
								number={sort === "newest" ? index + 1 : i + 1}
								onPlay={playTrack}
								onQueue={addToQueue}
								onRemove={playlist.editable ? removeSong : undefined}
								position={i}
								song={song}
							/>
						);
					}}
				</VirtualTrackList>
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
				open={editOpen}
				playlistId={id ?? null}
			/>
			<ConfirmDeletePlaylistDialog
				onOpenChange={setDeleteOpen}
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
	song: PlaylistTrack;
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
	onRemove?: (song: PlaylistTrack, index: number) => void;
}) {
	return (
		<SongContextMenu
			onRemove={editable && onRemove ? () => onRemove(song, index) : undefined}
			song={displaySong}
		>
			<SwipeToQueue onQueue={() => onQueue([displaySong])} song={displaySong}>
				<SongRowHover songId={displaySong.id}>
					<div
						className={cn(
							"flex items-center gap-3 rounded-lg px-4 py-2 sm:px-2.5",
							isCurrent && "bg-primary/8",
						)}
					>
						<button
							className="grid min-w-0 flex-1 grid-cols-[2rem_2.5rem_1fr] items-center gap-3 text-left"
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
									src={proxiedImageUrl(displaySong.thumbnail, 96)}
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
						</button>

						{/* Downloaded marker + rating + duration */}
						<div className="flex shrink-0 items-center gap-2 pr-2">
							<DownloadedBadge songId={displaySong.id} />
							<SongRowRating songId={displaySong.id} />
							<span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
								{displaySong.duration}
							</span>
						</div>
					</div>
				</SongRowHover>
			</SwipeToQueue>
		</SongContextMenu>
	);
});

export default function PlaylistsPage() {
	const navigate = useNavigate();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const { playlists, loading, failed, refresh } = usePlaylistLibrary();

	if (loading && playlists === null) {
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

	if (failed) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-6 sm:px-10 sm:pt-10">
				<h2 className="text-lg font-semibold text-destructive">
					Failed to load playlists.
				</h2>
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
					onClick={() => void refresh(true)}
					title="Refresh library"
					type="button"
				>
					<RefreshCw className={cn("size-4", loading && "animate-spin")} />
				</button>
			</div>

			<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
				{playlists?.map((item, index) => (
					<PlaylistContextMenu
						isPinned={isPinned(item.id)}
						key={item.id}
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
			{playlists?.length === 0 && (
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
