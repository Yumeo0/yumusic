import {
	ArrowLeftIcon,
	ArrowUpRight,
	AudioLines,
	Loader2,
	Music2,
	Play,
	RefreshCw,
	Shuffle,
} from "@lucide/solid";
import { useNavigate, useParams } from "@solidjs/router";
import { createEffect, createSignal, For, Show } from "solid-js";
import { YTNodes } from "youtubei.js/web";
import { EqualizerBars } from "@/components/player/waveform";
import { SwipeToQueue } from "@/components/queue/swipe-to-queue";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import { biggestThumb, cn, hiResThumb } from "@/lib/utils/utils";
import {
	artistListOf,
	artistNames,
	videoIdOf,
} from "@/lib/youtube/youtube.utils";
import {
	artistMixSource,
	getMixSongs,
	getYoutubeClient,
	type MixSource,
} from "@/lib/youtube/youtube-client";

// Auto-sync: fetch on first view, keep for the session, re-sync after 24h.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ShelfItem {
	title: string;
	subtitle: string;
	thumbnail: string | null;
	song?: Song;
	/** Route of a browsable entry (album, single, playlist, artist). */
	link?: string;
}

interface ArtistShelf {
	title: string;
	items: ShelfItem[];
}

interface ArtistView {
	name: string;
	description: string | null;
	thumbnail: string | null;
	songsTitle: string;
	songs: Song[];
	shelves: ArtistShelf[];
	/** Context for the header's "Mix" (radio) action, when the artist has one. */
	mix: MixSource | null;
}

const artistCache = new Map<string, { timestamp: number; data: ArtistView }>();

function toSong(item: YTNodes.MusicResponsiveListItem): Song {
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: artistNames(item),
		artists: artistListOf(item),
		thumbnail: hiResThumb(biggestThumb(item.thumbnail?.contents)?.url),
		duration: item.duration?.text,
	};
}

/**
 * MusicTwoRowItem is used for the artist's "Videos" carousel (no music shelf),
 * e.g. a VTuber channel that only uploads videos. These are still playable —
 * the id is the video id — so build a Song, crediting the channel.
 */
function toSongFromTwoRow(
	item: YTNodes.MusicTwoRowItem,
	artistName: string,
	artistId?: string,
): Song {
	return {
		id: videoIdOf(item),
		title: item.title?.text || "Unknown Title",
		artist: artistName,
		artistId,
		artists: artistName ? [{ name: artistName, id: artistId }] : undefined,
		thumbnail: hiResThumb(biggestThumb(item.thumbnail)?.url),
	};
}

/** Route of a browsable carousel entry: album/single, playlist or artist. */
function collectionLink(item: YTNodes.MusicTwoRowItem): string | undefined {
	if (!item.id) return undefined;
	switch (item.item_type) {
		case "album":
		case "playlist":
			return `/playlists/${item.id}`;
		case "artist":
			return `/artist/${item.id}`;
		default:
			return undefined;
	}
}

async function fetchArtistView(id: string, force = false): Promise<ArtistView> {
	const cached = artistCache.get(id);
	if (!force && cached && Date.now() - cached.timestamp < SYNC_INTERVAL_MS) {
		return cached.data;
	}

	const client = await getYoutubeClient();
	const artist = await client.music.getArtist(id);
	const header = artist.header;
	const mix = artistMixSource(header);

	let name = "Artist";
	let description: string | null = null;
	let thumbnail: string | null = null;
	if (header instanceof YTNodes.MusicImmersiveHeader) {
		name = header.title?.text || name;
		description = header.description?.toString() || null;
		thumbnail = hiResThumb(biggestThumb(header.thumbnail?.contents)?.url);
	} else if (header instanceof YTNodes.MusicVisualHeader) {
		name = header.title?.text || name;
		thumbnail = hiResThumb(biggestThumb(header.thumbnail)?.url);
	} else if (header instanceof YTNodes.MusicHeader) {
		name = header.title?.text || name;
	}

	const shelves: ArtistShelf[] = [];
	let songs: Song[] = [];
	let songsTitle = "Songs";

	for (const section of artist.sections ?? []) {
		if (section.is(YTNodes.MusicShelf)) {
			const shelfTitle = section.title?.text || "";
			const shelfSongs: Song[] = [];
			for (const item of section.contents ?? []) {
				if (item.is(YTNodes.MusicResponsiveListItem)) {
					const song = toSong(item);
					if (song.id) shelfSongs.push(song);
				}
			}
			if (/songs?/i.test(shelfTitle) && songs.length === 0) {
				songs = shelfSongs;
				songsTitle = shelfTitle;
			} else if (shelfSongs.length > 0) {
				shelves.push({
					title: shelfTitle,
					items: shelfSongs.map((song) => ({
						title: song.title,
						subtitle: song.artist,
						thumbnail: song.thumbnail,
						song,
					})),
				});
			}
		} else if (section.is(YTNodes.MusicCarouselShelf)) {
			const title = section.header?.title?.text || "";
			const items: ShelfItem[] = [];
			for (const item of section.contents ?? []) {
				if (item.is(YTNodes.MusicResponsiveListItem)) {
					const song = toSong(item);
					if (!song.id) continue;
					items.push({
						title: song.title,
						subtitle: song.artist,
						thumbnail: song.thumbnail,
						song,
					});
				} else if (item.is(YTNodes.MusicTwoRowItem)) {
					const twoRowSong =
						item.item_type === "video"
							? toSongFromTwoRow(item, name, id)
							: undefined;
					items.push({
						title: item.title?.text || "Unknown Title",
						subtitle: item.subtitle?.text || "",
						thumbnail: hiResThumb(biggestThumb(item.thumbnail)?.url),
						song: twoRowSong?.id ? twoRowSong : undefined,
						link: twoRowSong ? undefined : collectionLink(item),
					});
				}
			}
			if (items.length > 0) {
				shelves.push({ title, items });
			}
		}
	}

	const view: ArtistView = {
		name,
		description,
		thumbnail,
		songsTitle,
		songs,
		shelves,
		mix,
	};
	artistCache.set(id, { timestamp: Date.now(), data: view });
	return view;
}

export default function ArtistPage() {
	const params = useParams<{ id: string }>();
	const navigate = useNavigate();
	const player = usePlayer();
	const controls = usePlayerControls();
	// Video entries already resolved to their song version while playing.
	const versions = useSongVersionReplacements();
	const [artist, setArtist] = createSignal<ArtistView | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [error, setError] = createSignal<string | null>(null);
	const [mixPending, setMixPending] = createSignal(false);

	const loadArtist = async (id: string | undefined, force: boolean) => {
		if (!id) return;
		try {
			setLoading(true);
			setError(null);
			const view = await fetchArtistView(id, force);
			setArtist(view);
		} catch (err) {
			console.error("Error fetching artist:", err);
			setError("Failed to load artist.");
		} finally {
			setLoading(false);
		}
	};

	const fetchArtist = (force = false) => loadArtist(params.id, force);

	createEffect(
		() => params.id,
		(id) => {
			void loadArtist(id, false);
		},
	);

	const onBack = () => navigate(-1);

	const startMix = async () => {
		const mix = artist()?.mix;
		if (!mix || mixPending()) return;
		setMixPending(true);
		try {
			const songs = await getMixSongs(mix);
			if (songs.length === 0) {
				showToast("Could not start mix");
				return;
			}
			await player.playQueue(songs, 0);
		} finally {
			setMixPending(false);
		}
	};

	return (
		<Show
			fallback={
				<div class="mx-auto w-full max-w-5xl px-6 pt-10 sm:px-10">
					<div class="shimmer-surface h-9 w-24 rounded-full" />
					<div class="mt-8 flex gap-6">
						<div class="shimmer-surface size-44 rounded-full" />
						<div class="flex flex-1 flex-col justify-end gap-3 pb-2">
							<div class="shimmer-surface h-10 w-2/3 rounded-lg" />
							<div class="shimmer-surface h-3.5 w-52 rounded-md" />
						</div>
					</div>
					<div class="mt-10 space-y-2">
						<For each={[1, 2, 3, 4, 5]}>
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
							{error() || "Artist not found."}
						</h2>
					</div>
				}
				when={error() ? null : artist()}
			>
				{(view) => (
					<div class="mx-auto w-full max-w-5xl px-6 pt-10 pb-8 sm:px-10">
						<div class="flex items-center justify-between">
							<BackButton onClick={onBack} />
							<button
								class="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
								onClick={() => void fetchArtist(true)}
								title="Refresh artist"
								type="button"
							>
								<RefreshCw class="size-4" />
							</button>
						</div>

						{/* Header */}
						<header class="animate-track-in mt-6 flex items-end gap-6">
							<Show
								fallback={
									<div class="grid size-40 shrink-0 place-items-center rounded-full border border-foreground/10 bg-card sm:size-48">
										<Music2 class="size-10 text-muted-foreground" />
									</div>
								}
								when={view().thumbnail}
							>
								{(thumbnail) => (
									<img
										alt={view().name}
										class="size-40 shrink-0 rounded-full border border-foreground/10 object-cover sm:size-48"
										src={proxiedImageUrl(thumbnail())}
									/>
								)}
							</Show>
							<div class="min-w-0 pb-1">
								<h1 class="truncate text-3xl font-bold tracking-tight sm:text-4xl">
									{formatArtistName(view().name)}
								</h1>
								<Show when={view().description}>
									{(description) => (
										<p class="mt-2 line-clamp-2 max-w-xl text-sm text-muted-foreground">
											{description()}
										</p>
									)}
								</Show>
								<Show when={view().songs.length > 0 || view().mix}>
									<div class="mt-4 flex flex-wrap items-center gap-2.5">
										<Show when={view().songs.length > 0}>
											<button
												class="flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-95"
												onClick={() =>
													void player.play(
														view().songs[0],
														view().songs.slice(1),
													)
												}
												type="button"
											>
												<Play class="size-4 translate-x-[1px] fill-current" />
												Play
											</button>
										</Show>
										<Show when={view().songs.length > 0}>
											<button
												class="flex h-10 items-center gap-2 rounded-full border border-foreground/12 px-5 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95"
												onClick={() => {
													const shuffled = [...view().songs];
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
												<Shuffle class="size-4" />
												Shuffle
											</button>
										</Show>
										<Show when={view().mix}>
											<button
												class="flex h-10 items-center gap-2 rounded-full border border-foreground/12 px-5 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95 disabled:opacity-60"
												disabled={mixPending()}
												onClick={() => void startMix()}
												title="Start mix"
												type="button"
											>
												<Show
													fallback={<AudioLines class="size-4" />}
													when={mixPending()}
												>
													<Loader2 class="size-4 animate-spin" />
												</Show>
												Mix
											</button>
										</Show>
									</div>
								</Show>
							</div>
						</header>

						{/* Songs */}
						<Show when={view().songs.length > 0}>
							<div class="mt-10">
								<div class="mb-4 flex items-center gap-2">
									<h2 class="text-sm font-medium text-muted-foreground">
										{view().songsTitle}
									</h2>
									<span class="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
								</div>
								<div class="space-y-0.5">
									<For each={view().songs}>
										{(source, index) => {
											// Show the album track when the video was resolved.
											const song = () => versions.get(source.id) ?? source;
											const isCurrent = () =>
												player.currentSong()?.id === song().id;
											return (
												<SongContextMenu song={song()}>
													<SwipeToQueue
														onQueue={() => player.addToQueue([song()])}
													>
														<button
															class={cn(
																"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.05]",
																isCurrent() && "bg-primary/[0.08]",
															)}
															onClick={() =>
																void player.playQueue(view().songs, index())
															}
															type="button"
														>
															<span class="relative grid place-items-center">
																<Show
																	fallback={
																		<>
																			<span class="font-mono text-xs text-muted-foreground/60 transition-opacity duration-150 group-hover:opacity-0">
																				{index() + 1}
																			</span>
																			<Play class="absolute size-3.5 fill-current scale-75 text-foreground opacity-0 transition-all duration-150 group-hover:scale-100 group-hover:opacity-100" />
																		</>
																	}
																	when={isCurrent()}
																>
																	<EqualizerBars
																		class="size-3.5 text-primary"
																		playing={controls.isPlaying()}
																	/>
																</Show>
															</span>
															<Show
																fallback={
																	<div class="size-10 rounded-md bg-muted" />
																}
																when={song().thumbnail}
															>
																{(thumbnail) => (
																	<img
																		alt={song().title}
																		class="size-10 rounded-md border border-foreground/10 object-cover"
																		loading="lazy"
																		src={proxiedImageUrl(thumbnail())}
																	/>
																)}
															</Show>
															<div class="min-w-0">
																<h3
																	class={cn(
																		"truncate text-sm font-medium transition-colors duration-150 group-hover:text-primary",
																		isCurrent() && "text-primary",
																	)}
																>
																	<SongTitle
																		artist={song().artist}
																		keepTitle={song().upload}
																		title={song().title}
																	/>
																</h3>
																<p class="truncate text-xs text-muted-foreground">
																	<ArtistLinks song={song()} />
																</p>
															</div>
															<div class="flex items-center gap-2 pr-2">
																<DownloadedBadge songId={song().id} />
																<span class="font-mono text-xs text-muted-foreground/70 tabular-nums">
																	{song().duration}
																</span>
															</div>
														</button>
													</SwipeToQueue>
												</SongContextMenu>
											);
										}}
									</For>
								</div>
							</div>
						</Show>

						{/* Other shelves */}
						<For each={view().shelves}>
							{(shelf) => (
								<section class="mt-10">
									<div class="mb-4 flex items-center gap-2">
										<h2 class="text-sm font-medium text-muted-foreground">
											{shelf.title}
										</h2>
										<span class="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
									</div>
									<div class="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
										<For each={shelf.items}>
											{(item, i) => {
												const song = () =>
													item.song
														? (versions.get(item.song.id) ?? item.song)
														: undefined;
												return (
													<SongContextMenu song={song()}>
														<button
															class="group w-44 shrink-0 text-left disabled:cursor-default"
															onClick={() => {
																const current = song();
																if (current) {
																	void player.play(
																		current,
																		shelf.items
																			.slice(i() + 1)
																			.map((shelfItem) => shelfItem.song)
																			.filter((s): s is Song => Boolean(s)),
																	);
																} else if (item.link) {
																	navigate(item.link);
																}
															}}
															type="button"
														>
															<div class="relative aspect-square overflow-hidden rounded-xl border border-foreground/8 bg-card">
																<Show
																	fallback={
																		<div class="grid size-full place-items-center text-muted-foreground">
																			<Music2 class="size-8" />
																		</div>
																	}
																	when={item.thumbnail}
																>
																	{(thumbnail) => (
																		<img
																			alt={item.title}
																			class="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
																			loading="lazy"
																			src={proxiedImageUrl(thumbnail())}
																		/>
																	)}
																</Show>
																<Show when={item.song}>
																	<span class="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
																		<Play class="size-4 translate-x-[1px] fill-current" />
																	</span>
																</Show>
																<Show when={!item.song}>
																	<span class="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-all duration-200 group-hover:opacity-100">
																		<ArrowUpRight class="size-3.5" />
																	</span>
																</Show>
															</div>
															<h3 class="mt-2.5 line-clamp-1 text-sm font-medium transition-colors group-hover:text-primary">
																<SongTitle
																	artist={item.song?.artist}
																	keepTitle={item.song?.upload}
																	title={item.title}
																/>
															</h3>
															<p class="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
																<Show fallback={item.subtitle} when={item.song}>
																	{(shelfSong) => (
																		<ArtistLinks song={shelfSong()} />
																	)}
																</Show>
															</p>
														</button>
													</SongContextMenu>
												);
											}}
										</For>
									</div>
								</section>
							)}
						</For>
					</div>
				)}
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
			<span class="grid size-8 place-items-center rounded-full border border-foreground/10">
				<ArrowLeftIcon class="size-4" />
			</span>
			Back
		</button>
	);
}
