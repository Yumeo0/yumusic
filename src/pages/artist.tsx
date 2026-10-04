import {
	ArrowLeftIcon,
	ArrowUpRight,
	Music2,
	Play,
	RefreshCw,
	Shuffle,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { ArtistLinks } from "@/components/artist-link";
import { SongContextMenu } from "@/components/song-menu";
import { SongTitle } from "@/components/song-title";
import { SwipeToQueue } from "@/components/swipe-to-queue";
import { EqualizerBars } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { proxiedImageUrl } from "@/lib/tauri";
import { formatArtistName } from "@/lib/title";
import { cn, hiResThumb } from "@/lib/utils";
import { artistListOf, artistNames, videoIdOf } from "@/lib/youtube.utils";
import { getYoutubeClient } from "@/lib/youtube-client";

// Auto-sync: fetch on first view, keep for the session, re-sync after 24h.
const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface ShelfItem {
	title: string;
	subtitle: string;
	thumbnail: string | null;
	song?: Song;
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
}

const artistCache = new Map<string, { timestamp: number; data: ArtistView }>();

function toSong(item: YTNodes.MusicResponsiveListItem): Song {
	return {
		id: videoIdOf(item),
		title: item.title ?? "Unknown Title",
		artist: artistNames(item),
		artists: artistListOf(item),
		thumbnail: hiResThumb(
			item.thumbnail?.contents?.[item.thumbnail.contents.length - 1]?.url,
		),
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
		thumbnail: hiResThumb(
			item.thumbnail?.[item.thumbnail.length - 1]?.url || null,
		),
	};
}

async function fetchArtistView(id: string, force = false): Promise<ArtistView> {
	const cached = artistCache.get(id);
	if (!force && cached && Date.now() - cached.timestamp < SYNC_INTERVAL_MS) {
		return cached.data;
	}

	const client = await getYoutubeClient();
	const artist = await client.music.getArtist(id);
	const header = artist.header;

	let name = "Artist";
	let description: string | null = null;
	let thumbnail: string | null = null;
	if (header instanceof YTNodes.MusicImmersiveHeader) {
		name = header.title?.text || name;
		description = header.description?.toString() || null;
		thumbnail = hiResThumb(
			header.thumbnail?.contents?.[header.thumbnail.contents.length - 1]?.url ||
				null,
		);
	} else if (header instanceof YTNodes.MusicVisualHeader) {
		name = header.title?.text || name;
		thumbnail = hiResThumb(
			header.thumbnail?.[header.thumbnail.length - 1]?.url || null,
		);
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
					items: shelfSongs.map((s) => ({
						title: s.title,
						subtitle: s.artist,
						thumbnail: s.thumbnail,
						song: s,
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
						thumbnail: hiResThumb(
							item.thumbnail?.[item.thumbnail.length - 1]?.url || null,
						),
						song: twoRowSong?.id ? twoRowSong : undefined,
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
	};
	artistCache.set(id, { timestamp: Date.now(), data: view });
	return view;
}

export default function ArtistPage() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const { play, playQueue, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [artist, setArtist] = useState<ArtistView | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const artistName = artist?.name;

	const fetchArtist = async (force = false) => {
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchArtist changes on every re-render and should not be used as a hook dependency.
	useEffect(() => {
		fetchArtist();
	}, [id]);

	const onBack = () => navigate(-1);

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
				<button
					className="grid size-9 place-items-center rounded-full text-muted-foreground transition-colors duration-200 hover:bg-foreground/8 hover:text-foreground"
					onClick={() => fetchArtist(true)}
					title="Refresh artist"
					type="button"
				>
					<RefreshCw className="size-4" />
				</button>
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
					{artist.songs.length > 0 && (
						<div className="mt-4 flex items-center gap-2.5">
							<button
								className="flex h-10 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-95"
								onClick={() => play(artist.songs[0], artist.songs.slice(1))}
								type="button"
							>
								<Play className="size-4 translate-x-[1px] fill-current" />
								Play
							</button>
							<button
								className="flex h-10 items-center gap-2 rounded-full border border-foreground/12 px-5 text-sm font-medium transition-colors duration-200 hover:border-primary/40 hover:text-primary active:scale-95"
								onClick={() => {
									const shuffled = [...artist.songs];
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
					)}
				</div>
			</header>

			{/* Songs */}
			{artist.songs.length > 0 && (
				<div className="mt-10">
					<div className="mb-4 flex items-center gap-2">
						<h2 className="text-sm font-medium text-muted-foreground">
							{artist.songsTitle}
						</h2>
						<span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
					</div>
					<div className="space-y-0.5">
						{artist.songs.map((song, index) => {
							const isCurrent = currentSong?.id === song.id;
							return (
								<SongContextMenu
									// biome-ignore lint/suspicious/noArrayIndexKey: song list may contain duplicate video ids
									key={`${song.id ?? "artist-song"}-${index}`}
									song={song}
								>
									<SwipeToQueue onQueue={() => addToQueue([song])}>
										<button
											className={cn(
												"group grid w-full grid-cols-[2rem_2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.05]",
												isCurrent && "bg-primary/[0.08]",
											)}
											onClick={() => playQueue(artist.songs, index)}
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
													<SongTitle artist={song.artist} title={song.title} />
												</h3>
												<p className="truncate text-xs text-muted-foreground">
													<ArtistLinks song={song} />
												</p>
											</div>
											<span className="pr-2 font-mono text-xs text-muted-foreground/70 tabular-nums">
												{song.duration}
											</span>
										</button>
									</SwipeToQueue>
								</SongContextMenu>
							);
						})}
					</div>
				</div>
			)}

			{/* Other shelves */}
			{artist.shelves.map((shelf) => (
				<section className="mt-10" key={`shelf-${shelf.title}`}>
					<div className="mb-4 flex items-center gap-2">
						<h2 className="text-sm font-medium text-muted-foreground">
							{shelf.title}
						</h2>
						<span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
					</div>
					<div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
						{shelf.items.map((item, i) => (
							<SongContextMenu
								// biome-ignore lint/suspicious/noArrayIndexKey: shelf items may repeat titles
								key={`${item.title}-${i}`}
								song={item.song}
							>
								<button
									className="group w-44 shrink-0 text-left disabled:cursor-default"
									onClick={() => {
										if (item.song) {
											play(
												item.song,
												shelf.items
													.slice(i + 1)
													.map((shelfItem) => shelfItem.song)
													.filter((s): s is Song => Boolean(s)),
											);
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
										<SongTitle artist={item.song?.artist} title={item.title} />
									</h3>
									<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
										{item.song ? (
											<ArtistLinks song={item.song} />
										) : (
											item.subtitle
										)}
									</p>
								</button>
							</SongContextMenu>
						))}
					</div>
				</section>
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
