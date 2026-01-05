import { ArrowLeftIcon, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	getPlaylist,
	getUserPlaylists,
	type Playlist,
} from "../lib/youtube-client";

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> {
	data: T;
	timestamp: number;
}

const playlistDetailsCache: Record<string, CacheEntry<Playlist>> = {};
let playlistsListCache: CacheEntry<YTNodes.MusicTwoRowItem[]> | null = null;

export function PlaylistDetails() {
	const { id } = useParams<{ id: string }>();
	const navigate = useNavigate();
	const [playlist, setPlaylist] = useState<Playlist | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchPlaylist = async (force = false) => {
		if (!id) return;

		if (
			!force &&
			playlistDetailsCache[id] &&
			Date.now() - playlistDetailsCache[id].timestamp < CACHE_DURATION
		) {
			setPlaylist(playlistDetailsCache[id].data);
			setLoading(false);
			return;
		}

		try {
			setLoading(true);
			const data = await getPlaylist(id);
			setPlaylist(data);
			playlistDetailsCache[id] = {
				data,
				timestamp: Date.now(),
			};
		} catch (err) {
			console.error("Error fetching playlist:", err);
			setError("Failed to load playlist.");
		} finally {
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
			<div className="container mx-auto p-6">
				<Button className="mb-4" onClick={onBack} variant="ghost">
					<ArrowLeftIcon className="w-4 h-4 mr-2" />
					Back to Library
				</Button>
				<h2 className="text-2xl font-bold mb-4">Loading playlist...</h2>
				<div className="space-y-4">
					{[1, 2, 3, 4, 5].map((i) => (
						<Card className="h-20 animate-pulse bg-muted" key={i} />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="container mx-auto p-6">
				<Button className="mb-4" onClick={onBack} variant="ghost">
					<ArrowLeftIcon className="w-4 h-4 mr-2" />
					Back to Library
				</Button>
				<h2 className="text-2xl font-bold mb-4 text-destructive">{error}</h2>
			</div>
		);
	}

	return (
		<div className="container mx-auto p-6">
			<div className="flex items-center justify-between mb-4">
				<Button onClick={onBack} variant="ghost">
					<ArrowLeftIcon className="w-4 h-4 mr-2" />
					Back to Library
				</Button>
				<Button
					disabled={loading}
					onClick={() => fetchPlaylist(true)}
					size="icon"
					title="Refresh Playlist"
					variant="outline"
				>
					<RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
				</Button>
			</div>

			<div className="flex items-end gap-6 mb-8">
				{playlist?.header instanceof YTNodes.MusicResponsiveHeader && (
					<>
						{playlist.header.thumbnail?.contents?.[0]?.url && (
							<img
								alt={playlist.header.title?.text}
								className="w-48 h-48 object-cover rounded-lg shadow-lg"
								src={playlist.header.thumbnail.contents[0].url}
							/>
						)}
						<div>
							<h1 className="text-4xl font-bold mb-2">
								{playlist.header.title?.text}
							</h1>
							<p className="text-muted-foreground">
								{playlist.header.subtitle?.text}
							</p>
						</div>
					</>
				)}
			</div>

			<div className="space-y-2">
				{playlist?.items?.map((item) => {
					if (!item.is(YTNodes.MusicResponsiveListItem)) return null;

					return (
						<Card
							className="p-0 flex flex-row items-center gap-4 hover:bg-muted/50 transition-colors"
							key={item.id}
						>
							{item.thumbnail.contents[0].url && (
								<img
									alt={item.title}
									className="w-16 h-16 object-cover rounded"
									src={item.thumbnail.contents[0].url}
								/>
							)}
							<div className="flex-1 min-w-0">
								<h3 className="font-medium truncate">{item.title}</h3>
								<p className="text-sm text-muted-foreground truncate">
									{item.artists?.map((artist) => artist.name).join(", ")}
								</p>
							</div>
							<div className="text-sm text-muted-foreground">
								{item.duration?.text}
							</div>
						</Card>
					);
				})}
			</div>
		</div>
	);
}

export default function PlaylistsPage() {
	const navigate = useNavigate();
	const [items, setItems] = useState<YTNodes.MusicTwoRowItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchPlaylists = async (force = false) => {
		if (
			!force &&
			playlistsListCache &&
			Date.now() - playlistsListCache.timestamp < CACHE_DURATION
		) {
			setItems(playlistsListCache.data);
			setLoading(false);
			return;
		}

		try {
			setLoading(true);
			const library = await getUserPlaylists();

			const foundItems: YTNodes.MusicTwoRowItem[] = [];

			for (const section of library.contents) {
				if (section.contents) {
					foundItems.push(
						...section.contents.filterType(YTNodes.MusicTwoRowItem),
					);
				}
			}

			const playlists = foundItems.filter(
				(item) => item.item_type === "playlist",
			);
			setItems(playlists);
			playlistsListCache = {
				data: playlists,
				timestamp: Date.now(),
			};
		} catch (err) {
			console.error("Error fetching playlists:", err);
			setError("Failed to load playlists.");
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
			<div className="container mx-auto p-6">
				<h2 className="text-2xl font-bold mb-4">Loading library...</h2>
				<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
					{[1, 2, 3, 4, 5, 6].map((i) => (
						<Card className="h-64 animate-pulse bg-muted" key={i} />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="container mx-auto p-6">
				<h2 className="text-2xl font-bold mb-4 text-destructive">{error}</h2>
			</div>
		);
	}

	return (
		<div className="container mx-auto p-6">
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-2xl font-bold">Your Library</h2>
				<Button
					disabled={loading}
					onClick={() => fetchPlaylists(true)}
					size="icon"
					title="Refresh Library"
					variant="outline"
				>
					<RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
				</Button>
			</div>
			<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
				{items.map((item, index) => {
					// Try to extract common fields
					const title = item.title?.text || "Unknown Title";
					const subtitle = item.subtitle?.text || "";
					const thumbnail = item.thumbnail?.[0]?.url;
					const id = item.id || index;

					return (
						<Card
							className="overflow-hidden hover:shadow-lg transition-shadow cursor-pointer p-0 gap-0"
							key={id}
							onClick={() => navigate(`/playlists/${item.id}`)}
						>
							<div className="relative aspect-video bg-muted">
								{thumbnail ? (
									<img
										alt={title}
										className="w-full h-full object-cover"
										src={thumbnail}
									/>
								) : (
									<div className="w-full h-full flex items-center justify-center text-muted-foreground">
										No Image
									</div>
								)}
							</div>
							<div className="p-4">
								<h3 className="font-semibold line-clamp-2 mb-1">{title}</h3>
								<p className="text-sm text-muted-foreground line-clamp-1">
									{subtitle}
								</p>
							</div>
						</Card>
					);
				})}
			</div>
			{items.length === 0 && (
				<div className="text-center text-muted-foreground mt-12">
					<p>No items found in your library.</p>
				</div>
			)}
		</div>
	);
}
