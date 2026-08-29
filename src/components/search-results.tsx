import { useEffect, useState } from "react";
import { YTNodes } from "youtubei.js/web";
import { Card } from "@/components/ui/card";
import { usePlayer } from "@/contexts/player-context";
import { getYoutubeClient } from "../lib/youtube-client";

interface SearchResultsPageProps {
	query: string;
}

export default function SearchResults({ query }: SearchResultsPageProps) {
	const { play } = usePlayer();
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

	if (loading) {
		return (
			<div>
				<h2 className="text-2xl font-bold mb-4">Searching for "{query}"...</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					<Card className="h-64 animate-pulse bg-muted" />
					<Card className="h-64 animate-pulse bg-muted" />
					<Card className="h-64 animate-pulse bg-muted" />
					<Card className="h-64 animate-pulse bg-muted" />
					<Card className="h-64 animate-pulse bg-muted" />
					<Card className="h-64 animate-pulse bg-muted" />
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div>
				<h2 className="text-2xl font-bold mb-4 text-destructive">{error}</h2>
			</div>
		);
	}

	return (
		<div>
			<h2 className="text-2xl font-bold mb-4">Search results for "{query}"</h2>
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
				{results.map((video) => (
					<Card
						className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer"
						key={video.id}
						onClick={() =>
							play({
								id: video.id ?? "",
								title: video.title ?? "Unknown Title",
								artist: video.artists?.[0]?.name || "Unknown Artist",
								thumbnail:
									video.thumbnails?.[video.thumbnails.length - 1]?.url || "",
								duration: video.duration?.text,
							})
						}
					>
						<div className="relative aspect-video">
							<img
								alt={video.title}
								className="w-full h-full object-cover"
								src={video.thumbnails[0]?.url}
							/>
							{video.duration?.text && (
								<div className="absolute bottom-2 right-2 bg-black/80 text-white px-2 py-1 rounded text-xs">
									{video.duration.text}
								</div>
							)}
						</div>
						<div className="p-4">
							<h3 className="font-semibold line-clamp-2 mb-2">{video.title}</h3>
							{video.artists && video.artists.length > 0 && (
								<div className="flex items-center gap-2 mb-1">
									<p className="text-sm text-muted-foreground">
										{video.artists.map((artist) => artist.name).join(", ")}
									</p>
								</div>
							)}
							<div className="flex items-center gap-2 text-xs text-muted-foreground">
								{video.views && <span>{video.views}</span>}
								{video.year && <span>• {video.year}</span>}
							</div>
						</div>
					</Card>
				))}
			</div>
		</div>
	);
}
