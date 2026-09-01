import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { YTNodes } from "youtubei.js/web";
import { ArtistLinks } from "@/components/artist-link";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { hiResThumb } from "@/lib/utils";
import { artistIdOf, artistListOf, artistNames } from "../lib/youtube.utils";
import { getYoutubeClient } from "../lib/youtube-client";

interface SearchResultsPageProps {
	query: string;
}

export default function SearchResults({ query }: SearchResultsPageProps) {
	const { play, currentSong, isPlaying } = usePlayer();
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
							songs.push(...section.contents);
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
		id: video.id ?? "",
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
				<div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
					{Array.from({ length: 8 }, (_, i) => (
						<div
							className="animate-track-in"
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
							key={i}
							style={{ animationDelay: `${i * 45}ms` }}
						>
							<div className="shimmer-surface aspect-square rounded-xl" />
							<div className="shimmer-surface mt-3 h-4 w-3/4 rounded-md" />
							<div className="shimmer-surface mt-2 h-3 w-1/2 rounded-md" />
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
			<div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
				{results.map((video, i) => {
					const song = toSong(video);
					const isCurrent = currentSong?.id === song.id;
					return (
						<button
							className="group animate-track-in relative overflow-hidden rounded-xl border border-foreground/8 bg-card text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40"
							// biome-ignore lint/suspicious/noArrayIndexKey: search results may repeat video ids across shelves
							key={`${video.id}-${i}`}
							onClick={() => play(song)}
							style={{ animationDelay: `${Math.min(i * 35, 400)}ms` }}
							type="button"
						>
							<div className="relative aspect-square overflow-hidden">
								{song.thumbnail && (
									<img
										alt={video.title}
										className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
										crossOrigin="anonymous"
										loading="lazy"
										src={song.thumbnail}
									/>
								)}
								{video.duration?.text && (
									<span className="absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
										{video.duration.text}
									</span>
								)}
								{/* Play on hover */}
								<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
									{isCurrent && isPlaying ? (
										<span
											aria-hidden
											className="inline-flex h-3.5 items-end gap-[2px]"
										>
											{[0, 1, 2].map((j) => (
												<span
													className="animate-eq w-[3px] origin-bottom rounded-full bg-current"
													key={j}
													style={{
														height: "100%",
														animationDelay: `${j * 160}ms`,
													}}
												/>
											))}
										</span>
									) : (
										<Play className="size-4 translate-x-[1px] fill-current" />
									)}
								</span>
							</div>
							<div className="p-3">
								<h3
									className={`line-clamp-1 text-sm font-medium transition-colors duration-200 group-hover:text-primary ${isCurrent ? "text-primary" : ""}`}
								>
									{video.title}
								</h3>
								<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
									<ArtistLinks song={song} />
								</p>
							</div>
						</button>
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
