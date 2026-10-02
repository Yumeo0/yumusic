import { useEffect, useState } from "react";
import { YTNodes } from "youtubei.js/web";
import { ArtistLinks } from "@/components/artist-link";
import { SongContextMenu } from "@/components/song-menu";
import { SongTitle } from "@/components/song-title";
import { SwipeToQueue } from "@/components/swipe-to-queue";
import { EqualizerBars } from "@/components/waveform";
import type { Song } from "@/contexts/player-context";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { proxiedImageUrl } from "@/lib/tauri";
import { cn, hiResThumb } from "@/lib/utils";
import {
	artistIdOf,
	artistListOf,
	artistNames,
	videoIdOf,
} from "../lib/youtube.utils";
import { getYoutubeClient } from "../lib/youtube-client";

interface SearchResultsPageProps {
	query: string;
}

export default function SearchResults({ query }: SearchResultsPageProps) {
	const { play, addToQueue, currentSong } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [results, setResults] = useState<YTNodes.MusicResponsiveListItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const searchYouTube = async () => {
			try {
				setLoading(true);
				setError(null);

				const youtube = await getYoutubeClient();
				const search = await youtube.music.search(query, {
					type: "song",
				});

				// Extract all items from contents
				const songs: YTNodes.MusicResponsiveListItem[] = [];
				if (search.contents) {
					for (const section of search.contents) {
						if (section instanceof YTNodes.MusicShelf) {
							songs.push(...section.contents.filter((item) => videoIdOf(item)));
						}
					}
				}

				setResults(songs);
			} catch (err) {
				console.error("Search error:", err);
				setError("Failed to search YouTube. Please try again.");
			} finally {
				setLoading(false);
			}
		};

		if (query) {
			searchYouTube();
		}
	}, [query]);

	const toSong = (video: YTNodes.MusicResponsiveListItem): Song => ({
		id: videoIdOf(video),
		title: video.title ?? "Unknown Title",
		artist: artistNames(video),
		artistId: artistIdOf(video.artists),
		artists: artistListOf(video),
		thumbnail: hiResThumb(video.thumbnails?.[video.thumbnails.length - 1]?.url),
		duration: video.duration?.text,
	});

	if (loading) {
		return (
			<div>
				<SectionHeader label={`Searching for "${query}"`} />
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
			</div>
		);
	}

	if (error) {
		return (
			<div>
				<SectionHeader label={`Results for "${query}"`} />
				<h2 className="py-10 text-sm text-destructive">{error}</h2>
			</div>
		);
	}

	return (
		<div>
			<SectionHeader count={results.length} label={`Results for "${query}"`} />
			<div className="space-y-0.5">
				{results.map((video, i) => {
					const song = toSong(video);
					const isCurrent = currentSong?.id === song.id;
					return (
						<SongContextMenu
							// biome-ignore lint/suspicious/noArrayIndexKey: search results may repeat video ids across shelves
							key={`${video.id}-${i}`}
							song={song}
						>
							<SwipeToQueue onQueue={() => addToQueue([song])}>
								<button
									className={cn(
										"group grid w-full grid-cols-[2.5rem_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/5",
										isCurrent && "bg-primary/8",
									)}
									onClick={() => play(song)}
									style={{ animationDelay: `${Math.min(i * 25, 300)}ms` }}
									type="button"
								>
									{song.thumbnail ? (
										<img
											alt={video.title}
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
												title={video.title ?? ""}
											/>
										</h3>
										<p className="truncate text-xs text-muted-foreground">
											<ArtistLinks song={song} />
										</p>
									</div>
									{isCurrent && isPlaying ? (
										<EqualizerBars className="mr-1 size-3.5 text-primary" />
									) : (
										<span className="pr-1 font-mono text-xs text-muted-foreground/70 tabular-nums">
											{video.duration?.text}
										</span>
									)}
								</button>
							</SwipeToQueue>
						</SongContextMenu>
					);
				})}
			</div>
			{results.length === 0 && (
				<p className="py-10 text-sm text-muted-foreground">
					Nothing found — try a different search.
				</p>
			)}
		</div>
	);
}

function SectionHeader({ label, count }: { label: string; count?: number }) {
	return (
		<div className="mb-4 flex items-baseline gap-2">
			<h2 className="text-sm text-muted-foreground">{label}</h2>
			{count !== undefined && (
				<span className="text-xs text-muted-foreground/50">({count})</span>
			)}
		</div>
	);
}
