import {
	ArrowLeftIcon,
	ArrowUpRight,
	AudioLines,
	ChevronRight,
	Loader2,
	Music2,
	Play,
	RefreshCw,
	Share2,
	Shuffle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { EqualizerBars } from "@/components/player/waveform";
import { VirtualTrackList } from "@/components/playlist/virtual-track-list";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongRowHover, SongRowRating } from "@/components/song/song-row-hover";
import { SongTitle } from "@/components/song/song-title";
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import type { Song } from "@/lib/music/song";
import { shuffleFrom } from "@/lib/player/shuffle";
import { shareLink } from "@/lib/services/share";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import { cn } from "@/lib/utils/utils";
import {
	type ArtistShelfItem,
	loadArtistCategoryItems,
} from "@/lib/youtube/artist-category";
import { type ArtistView, fetchArtistView } from "@/lib/youtube/artist-data";
import { getYoutubeClient } from "@/lib/youtube/client-session";
import { getMixSongs } from "@/lib/youtube/youtube-client";

export default function ArtistPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { play, playQueue } = usePlayer();
	const [artist, setArtist] = useState<ArtistView | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [mixPending, setMixPending] = useState(false);
	const artistName = artist?.name;

	const requestId = useRef(0);
	const fetchArtist = async (force = false) => {
		if (!id) return;
		const request = ++requestId.current;
		try {
			setLoading(true);
			setError(null);
			const view = await fetchArtistView(id, force);
			if (requestId.current === request) setArtist(view);
		} catch (error) {
			if (requestId.current !== request) return;
			console.error("Error fetching artist:", error);
			setError("Failed to load artist.");
		} finally {
			if (requestId.current === request) setLoading(false);
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: each route id owns its requests.
	useEffect(() => {
		void fetchArtist();
		return () => {
			requestId.current++;
		};
	}, [id]);

	const onBack = () => navigate(-1);

	const startMix = async () => {
		if (!artist?.mix || mixPending) return;
		setMixPending(true);
		try {
			const songs = await getMixSongs(artist.mix);
			if (songs.length === 0) {
				showToast("Could not start mix");
				return;
			}
			playQueue(songs, 0);
		} finally {
			setMixPending(false);
		}
	};

	if (loading) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
				<div className="shimmer-surface h-9 w-24 rounded-full" />
				<div className="mt-8 flex gap-6">
					<div className="shimmer-surface size-44 rounded-full" />
					<div className="flex flex-1 flex-col justify-end gap-3 pb-2">
						<div className="shimmer-surface h-10 w-2/3 rounded-lg" />
						<div className="shimmer-surface h-3.5 w-52 rounded-md" />
					</div>
				</div>
				<div className="mt-10 space-y-2">
					{[1, 2, 3, 4, 5].map((i) => (
						<div className="shimmer-surface h-14 rounded-lg" key={`row-${i}`} />
					))}
				</div>
			</div>
		);
	}

	if (error || !artist) {
		return (
			<div className="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
				<BackButton onClick={onBack} />
				<h2 className="mt-8 text-lg font-semibold text-destructive">
					{error || "Artist not found."}
				</h2>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-5xl px-6 pt-10 pb-8 sm:px-10">
			<div className="flex items-center justify-between">
				<BackButton onClick={onBack} />
				<div className="flex items-center gap-1">
					<button
						aria-label="Share artist or channel"
						className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
						onClick={() =>
							void shareLink({
								title: artist.name,
								url: artist.shareUrl,
							})
						}
						title="Share artist or channel"
						type="button"
					>
						<Share2 className="size-4" />
					</button>
					<button
						className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
						onClick={() => fetchArtist(true)}
						title="Refresh artist"
						type="button"
					>
						<RefreshCw className="size-4" />
					</button>
				</div>
			</div>

			{/* Header */}
			<header className="animate-track-in mt-6 flex items-end gap-6">
				{artist.thumbnail ? (
					<img
						alt={artist.name}
						className="size-40 shrink-0 rounded-full border border-foreground/10 object-cover sm:size-48"
						src={proxiedImageUrl(artist.thumbnail)}
					/>
				) : (
					<div className="grid size-40 shrink-0 place-items-center rounded-full border border-foreground/10 bg-card sm:size-48">
						<Music2 className="size-10 text-muted-foreground" />
					</div>
				)}
				<div className="min-w-0 pb-1">
					<h1 className="truncate text-3xl font-bold tracking-tight sm:text-4xl">
						{formatArtistName(artistName || artist.name)}
					</h1>
					{artist.description && (
						<p className="mt-2 line-clamp-2 max-w-xl text-sm text-muted-foreground">
							{artist.description}
						</p>
					)}
					{(artist.songs.length > 0 || artist.mix) && (
						<div className="mt-4 flex flex-wrap items-center gap-2.5">
							{artist.songs.length > 0 && (
								<button
									className="flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-95"
									onClick={() => play(artist.songs[0], artist.songs.slice(1))}
									type="button"
								>
									<Play className="size-4 translate-x-[1px] fill-current" />
									Play
								</button>
							)}
							{artist.songs.length > 0 && (
								<button
									className="flex h-10 items-center gap-2 rounded-full border border-foreground/12 px-5 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95"
									onClick={() => {
										const shuffled = shuffleFrom(artist.songs, 0);
										play(shuffled[0], shuffled.slice(1));
									}}
									title="Shuffle play"
									type="button"
								>
									<Shuffle className="size-4" />
									Shuffle
								</button>
							)}
							{artist.mix && (
								<button
									className="flex h-10 items-center gap-2 rounded-full border border-foreground/12 px-5 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:opacity-60"
									disabled={mixPending}
									onClick={() => void startMix()}
									title="Start mix"
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
						</div>
					)}
				</div>
			</header>

			{artist.songs.length > 0 && (
				<section className="mt-10">
					<ArtistShelfHeading
						artistId={id}
						category={artist.songsCategory}
						title={artist.songsTitle}
					/>
					<ArtistSongRows songs={artist.songs} />
				</section>
			)}

			{artist.shelves.map((shelf, index) => (
				<section
					className="mt-10"
					key={shelf.category ?? `${shelf.title}-${index}`}
				>
					<ArtistShelfHeading
						artistId={id}
						category={shelf.category}
						title={shelf.title}
					/>
					<ArtistShelfCards items={shelf.items} />
				</section>
			))}
		</div>
	);
}

type CategoryState =
	| { status: "loading" | "unavailable" | "error" }
	| {
			status: "ready";
			title: string;
			artistName: string;
			items: ArtistShelfItem[];
	  };

export function ArtistCategoryPage() {
	const { id = "", category = "" } = useParams();
	const navigate = useNavigate();
	const location = useLocation();
	const page = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<CategoryState>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		page.current
			?.closest<HTMLElement>("[data-slot=scroll-area-viewport]")
			?.scrollTo(0, 0);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;

		async function loadCategory() {
			try {
				const artist = await fetchArtistView(id, attempt > 0);
				signal.throwIfAborted();
				const source = artist.categories.get(category);
				if (!source) {
					setState({ status: "unavailable" });
					return;
				}
				const client = await getYoutubeClient();
				signal.throwIfAborted();
				const items = await loadArtistCategoryItems(
					client.actions,
					source.endpoint,
					artist.name,
					id,
					signal,
				);
				if (!signal.aborted) {
					setState({
						status: "ready",
						title: source.title,
						artistName: artist.name,
						items,
					});
				}
			} catch (error) {
				if (signal.aborted) return;
				console.error("Error fetching artist category:", error);
				setState({ status: "error" });
			}
		}

		void loadCategory();
		return () => controller.abort();
	}, [id, category, attempt]);

	const onBack = () => {
		if (location.state?.fromArtist) {
			navigate(-1);
		} else {
			navigate(`/artist/${encodeURIComponent(id)}`, { replace: true });
		}
	};
	const songs =
		state.status === "ready"
			? state.items.flatMap((item) => (item.song ? [item.song] : []))
			: [];

	return (
		<div
			className="mx-auto w-full max-w-5xl px-6 pt-10 pb-8 sm:px-10"
			ref={page}
		>
			<BackButton onClick={onBack} />
			<div className="mt-8">
				{state.status === "loading" && (
					<p
						className="flex items-center gap-2 text-sm text-muted-foreground"
						role="status"
					>
						<Loader2
							aria-hidden="true"
							className="size-4 animate-spin motion-reduce:animate-none"
						/>
						Loading category…
					</p>
				)}
				{state.status === "unavailable" && (
					<p className="text-sm text-muted-foreground">
						This category is unavailable.
					</p>
				)}
				{state.status === "error" && (
					<Alert variant="destructive">
						<AlertTitle>Couldn’t load this category.</AlertTitle>
						<AlertAction>
							<Button
								onClick={() => {
									setState({ status: "loading" });
									setAttempt((value) => value + 1);
								}}
								size="xs"
								variant="outline"
							>
								Retry
							</Button>
						</AlertAction>
					</Alert>
				)}
				{state.status === "ready" && (
					<>
						<h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
							{state.title}
						</h1>
						<p className="mt-2 text-sm text-muted-foreground">
							{formatArtistName(state.artistName)}
						</p>
						<div className="mt-6">
							{state.items.length === 0 ? (
								<p className="text-sm text-muted-foreground">No items found.</p>
							) : songs.length === state.items.length ? (
								<ArtistSongRows songs={songs} virtual />
							) : (
								<ArtistShelfCards grid items={state.items} />
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

function ArtistShelfHeading({
	artistId,
	category,
	title,
}: {
	artistId?: string;
	category?: string;
	title: string;
}) {
	return (
		<div className="mb-4 flex items-center gap-3">
			<h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
			<span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
			{artistId && category && (
				<Link
					aria-label={`See all ${title || "items"}`}
					className={buttonVariants({ size: "sm", variant: "outline" })}
					state={{ fromArtist: true }}
					to={`/artist/${encodeURIComponent(artistId)}/category/${encodeURIComponent(category)}`}
				>
					See all
					<ChevronRight data-icon="inline-end" />
				</Link>
			)}
		</div>
	);
}

function ArtistSongRows({
	songs,
	virtual = false,
}: {
	songs: Song[];
	virtual?: boolean;
}) {
	const { playQueue, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const versions = useSongVersionReplacements();

	function renderSong(index: number) {
		const source = songs[index];
		// Show the album track when the video was resolved.
		const song = versions.get(source.id) ?? source;
		const isCurrent = currentSong?.id === song.id;
		return (
			<SongContextMenu key={`${song.id ?? "artist-song"}-${index}`} song={song}>
				<SwipeToQueue onQueue={() => addToQueue([song])} song={song}>
					<SongRowHover songId={song.id}>
						<div
							className={cn(
								"flex items-center gap-3 rounded-lg px-2.5 py-2",
								isCurrent && "bg-primary/[0.08]",
							)}
						>
							<button
								className="grid min-w-0 flex-1 grid-cols-[2rem_2.5rem_1fr] items-center gap-3 text-left"
								onClick={() => playQueue(songs, index)}
								type="button"
							>
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
							</button>
							<div className="flex shrink-0 items-center gap-2 pr-2">
								<DownloadedBadge songId={song.id} />
								<SongRowRating songId={song.id} />
								<span className="font-mono text-xs text-muted-foreground/70 tabular-nums">
									{song.duration}
								</span>
							</div>
						</div>
					</SongRowHover>
				</SwipeToQueue>
			</SongContextMenu>
		);
	}

	if (virtual) {
		return (
			<VirtualTrackList
				count={songs.length}
				getKey={(index) => `${songs[index].id}-${index}`}
			>
				{renderSong}
			</VirtualTrackList>
		);
	}

	return (
		<div className="flex flex-col gap-0.5">
			{songs.map((_, index) => renderSong(index))}
		</div>
	);
}

function ArtistShelfCards({
	items,
	grid = false,
}: {
	items: ArtistShelfItem[];
	grid?: boolean;
}) {
	const navigate = useNavigate();
	const { play } = usePlayer();
	const versions = useSongVersionReplacements();
	return (
		<div
			className={
				grid
					? "grid grid-cols-[repeat(auto-fill,minmax(min(100%,8rem),1fr))] gap-x-4 gap-y-6"
					: "-mx-1 flex gap-4 overflow-x-auto px-1 pb-2"
			}
		>
			{items.map((item, i) => (
				<SongContextMenu
					// biome-ignore lint/suspicious/noArrayIndexKey: shelf items may repeat titles
					key={`${item.title}-${i}`}
					song={
						item.song ? (versions.get(item.song.id) ?? item.song) : item.song
					}
				>
					<button
						className={cn(
							"group min-w-0 text-left disabled:cursor-default",
							grid ? "w-full" : "w-44 shrink-0",
						)}
						onClick={() => {
							if (item.song) {
								const song = versions.get(item.song.id) ?? item.song;
								play(
									song,
									items
										.slice(i + 1)
										.map((shelfItem) => shelfItem.song)
										.filter((s): s is Song => Boolean(s)),
								);
							} else if (item.link) {
								navigate(item.link);
							}
						}}
						type="button"
					>
						<div className="relative aspect-square overflow-hidden rounded-xl border border-foreground/8 bg-card">
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
							{item.song && (
								<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
									<Play className="size-4 translate-x-[1px] fill-current" />
								</span>
							)}
							{!item.song && (
								<span className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-all duration-200 group-hover:opacity-100">
									<ArrowUpRight className="size-3.5" />
								</span>
							)}
						</div>
						<h3 className="mt-2.5 line-clamp-1 text-sm font-medium transition-colors group-hover:text-primary">
							<SongTitle
								artist={item.song?.artist}
								keepTitle={item.song?.upload}
								title={item.title}
							/>
						</h3>
						<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
							{item.song ? (
								<ArtistLinks showType song={item.song} />
							) : (
								item.subtitle
							)}
						</p>
					</button>
				</SongContextMenu>
			))}
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
			<span className="grid size-8 place-items-center rounded-full border border-foreground/10">
				<ArrowLeftIcon className="size-4" />
			</span>
			Back
		</button>
	);
}
