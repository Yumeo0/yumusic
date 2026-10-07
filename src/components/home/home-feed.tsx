import { ArrowUpRight, Disc3, ListMusic } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { YTNodes } from "youtubei.js/web";
import { PlaylistContextMenu } from "@/components/playlist/playlist-menu";
import { ArtistLinks } from "@/components/song/artist-link";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { usePinnedPlaylists } from "@/lib/stores/pinned";
import { useSettings } from "@/lib/stores/settings";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import {
	biggestThumb,
	cn,
	hiResThumb,
	type ThumbCandidate,
} from "@/lib/utils/utils";
import {
	artistIdOf,
	artistListOf,
	artistNames,
	videoIdOf,
} from "@/lib/youtube/youtube.utils";
import { getYoutubeClient } from "@/lib/youtube/youtube-client";

/**
 * One card in a home feed row. Carousels mix tracks with playlists, albums
 * and artists; each kind renders its own card and click behavior.
 */
type FeedItem =
	| { kind: "song"; song: Song }
	| {
			kind: "playlist" | "album";
			id: string;
			title: string;
			subtitle: string;
			thumbnail: string;
	  }
	| {
			kind: "artist";
			id: string;
			name: string;
			subtitle: string;
			thumbnail: string;
	  };

interface FeedSection {
	title: string;
	items: FeedItem[];
}

/** Home sections the user can hide (normalized titles, see below). */
const HIDDEN_SECTION_TITLES = new Set(["today's biggest hits"]);

function isHiddenSectionTitle(title: string): boolean {
	const normalized = title
		.trim()
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'");
	return HIDDEN_SECTION_TITLES.has(normalized);
}

function lastThumb(urls: ThumbCandidate[] | undefined): string {
	return hiResThumb(biggestThumb(urls)?.url);
}

/** A playable card from a responsive list item (song/video/non-music track). */
function responsiveSong(
	item: YTNodes.MusicResponsiveListItem,
): FeedItem | null {
	const id = videoIdOf(item);
	if (!id) return null;
	return {
		kind: "song",
		song: {
			id,
			title: item.title ?? "Unknown Title",
			artist: artistNames(item),
			artistId: artistIdOf(item),
			artists: artistListOf(item),
			thumbnail: lastThumb(item.thumbnail?.contents),
			duration: item.duration?.text,
		},
	};
}

function toFeedItem(
	item: YTNodes.MusicResponsiveListItem | YTNodes.MusicTwoRowItem,
): FeedItem | null {
	if (item.is(YTNodes.MusicResponsiveListItem)) {
		switch (item.item_type) {
			case "song":
			case "video":
			case "non_music_track":
				return responsiveSong(item);
			case "playlist":
			case "album":
				if (!item.id) return null;
				return {
					kind: item.item_type,
					id: item.id,
					title: item.title ?? "Unknown Title",
					subtitle:
						item.item_type === "playlist"
							? (item.item_count ?? item.author?.name ?? "")
							: (item.author?.name ?? item.year ?? ""),
					thumbnail: lastThumb(item.thumbnail?.contents),
				};
			case "artist":
			case "library_artist":
				if (!item.id) return null;
				return {
					kind: "artist",
					id: item.id,
					name: item.name ?? item.title ?? "Unknown Artist",
					subtitle: item.subscribers ?? "Artist",
					thumbnail: lastThumb(item.thumbnail?.contents),
				};
			default:
				return null;
		}
	}

	const thumbnail = lastThumb(item.thumbnail);
	switch (item.item_type) {
		case "song":
		case "video": {
			const id = videoIdOf(item);
			if (!id) return null;
			const authorId = item.author?.channel_id;
			const authorName = item.author?.name;
			const artistList = (item.artists ?? [])
				.filter((a) => a.name)
				.map((a) => ({
					name: a.name,
					id: a.channel_id?.startsWith("UC") ? a.channel_id : undefined,
				}));
			if (artistList.length === 0 && authorName) {
				artistList.push({
					name: authorName,
					id: authorId?.startsWith("UC") ? authorId : undefined,
				});
			}
			return {
				kind: "song",
				song: {
					id,
					title: item.title?.text ?? "Unknown Title",
					artist:
						artistList
							.map((a) => a.name)
							.filter(Boolean)
							.join(", ") ||
						item.subtitle?.text ||
						"",
					artistId:
						artistList.find((a) => a.id)?.id ??
						(authorId?.startsWith("UC") ? authorId : undefined),
					artists: artistList,
					thumbnail,
					duration: undefined,
				},
			};
		}
		case "playlist":
		case "album":
			if (!item.id) return null;
			return {
				kind: item.item_type,
				id: item.id,
				title: item.title?.text || "Unknown Title",
				subtitle: item.subtitle?.text ?? "",
				thumbnail,
			};
		case "artist":
			if (!item.id) return null;
			return {
				kind: "artist",
				id: item.id,
				name: item.title?.text || "Unknown Artist",
				subtitle: item.subscribers ?? item.subtitle?.text ?? "Artist",
				thumbnail,
			};
		default:
			return null;
	}
}

function FeedCard({ item, onClick }: { item: FeedItem; onClick: () => void }) {
	const isArtist = item.kind === "artist";
	const title =
		item.kind === "song"
			? item.song.title
			: item.kind === "artist"
				? formatArtistName(item.name)
				: item.title;
	const subtitle = item.kind === "song" ? item.song.artist : item.subtitle;
	const thumbnail = item.kind === "song" ? item.song.thumbnail : item.thumbnail;

	return (
		<button
			className={cn(
				"group w-32 shrink-0 text-left md:w-44",
				isArtist && "text-center",
			)}
			onClick={onClick}
			type="button"
		>
			<div
				className={cn(
					"relative aspect-square overflow-hidden border border-foreground/8 bg-card",
					isArtist ? "rounded-full" : "rounded-xl",
				)}
			>
				{thumbnail && (
					<img
						alt={title}
						className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
						loading="lazy"
						src={proxiedImageUrl(thumbnail)}
					/>
				)}
				{(item.kind === "playlist" || item.kind === "album") && (
					<span className="pointer-events-none absolute bottom-2 left-2 grid size-7 place-items-center rounded-md bg-black/60 text-white shadow-sm backdrop-blur-xs">
						{item.kind === "playlist" ? (
							<ListMusic className="size-4" />
						) : (
							<Disc3 className="size-4" />
						)}
					</span>
				)}
				{item.kind === "song" ? (
					<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
						<svg
							aria-hidden
							className="size-4 translate-x-px fill-current"
							viewBox="0 0 24 24"
						>
							<path d="M8 5.14v13.72c0 1.23 1.34 1.98 2.39 1.36l11.02-6.86a1.6 1.6 0 0 0 0-2.72L10.39 3.78C9.34 3.16 8 3.91 8 5.14Z" />
						</svg>
					</span>
				) : (
					<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
						<ArrowUpRight className="size-4" />
					</span>
				)}
			</div>
			<h3 className="mt-2.5 line-clamp-1 text-sm font-medium transition-colors group-hover:text-primary">
				{item.kind === "song" ? (
					<SongTitle artist={item.song.artist} title={item.song.title} />
				) : (
					title
				)}
			</h3>
			<p
				className={cn(
					"mt-0.5 line-clamp-1 text-xs text-muted-foreground",
					isArtist && "text-center",
				)}
			>
				{item.kind === "song" ? <ArtistLinks song={item.song} /> : subtitle}
			</p>
		</button>
	);
}

/**
 * Recommended tracks, playlists, albums and artists from the YouTube Music
 * home feed, rendered as horizontally scrollable rows. Renders nothing while
 * signed out.
 */
export function HomeFeed() {
	const { play } = usePlayer();
	const navigate = useNavigate();
	const [settings] = useSettings();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const [sections, setSections] = useState<FeedSection[] | null>(null);
	const [failed, setFailed] = useState(false);

	const removeFeedItem = (id: string) =>
		setSections((prev) =>
			prev
				? prev.map((section) => ({
						...section,
						items: section.items.filter(
							(entry) =>
								entry.kind === "song" ||
								entry.kind === "artist" ||
								entry.id !== id,
						),
					}))
				: prev,
		);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const client = await getYoutubeClient();
				const feed = await client.music.getHomeFeed();

				const out: FeedSection[] = [];
				for (const section of feed.sections ?? []) {
					if (!section.is(YTNodes.MusicCarouselShelf)) continue;
					const title = section.header?.title?.text || "";
					const items: FeedItem[] = [];
					for (const item of section.contents ?? []) {
						if (
							!item.is(YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem)
						) {
							continue;
						}
						const feedItem = toFeedItem(item);
						if (feedItem) items.push(feedItem);
					}
					if (items.length > 0) {
						out.push({ title, items });
					}
				}

				if (cancelled) return;
				setSections(out);
				setFailed(out.length === 0);
			} catch (error) {
				console.warn("[HomeFeed] failed to load recommendations:", error);
				if (cancelled) return;
				setSections([]);
				setFailed(true);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (sections === null) {
		return (
			<div className="space-y-10">
				{[0, 1].map((row) => (
					<div key={`feed-skeleton-${row}`}>
						<div className="shimmer-surface mb-4 h-4 w-40 rounded-md" />
						<div className="flex gap-4">
							{Array.from({ length: 5 }, (_, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
									key={`s-${row}-${i}`}
								>
									<div className="shimmer-surface aspect-square w-32 rounded-xl md:w-44" />
									<div className="shimmer-surface mt-2.5 h-4 w-24 rounded-md md:w-32" />
									<div className="shimmer-surface mt-2 h-3 w-16 rounded-md md:w-24" />
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		);
	}

	if (failed) {
		return (
			<p className="text-sm text-muted-foreground/70">
				Recommendations unavailable — log in to see your mix.
			</p>
		);
	}

	const visibleSections = sections.filter(
		(section) =>
			!(settings.hideTodaysBiggestHits && isHiddenSectionTitle(section.title)),
	);

	return (
		<div>
			{visibleSections.map((section, si) => (
				<section
					className="animate-track-in pb-3"
					// biome-ignore lint/suspicious/noArrayIndexKey: home feed sections may repeat titles
					key={`feed-${section.title}-${si}`}
					style={{ animationDelay: `${si * 80}ms` }}
				>
					<div className="mb-4 flex items-center gap-2">
						<h2 className="text-sm font-medium text-muted-foreground">
							{section.title}
						</h2>
						<span className="h-px flex-1 bg-linear-to-r from-border to-transparent" />
					</div>
					<div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
						{section.items.map((item, i) => {
							const onOpen =
								item.kind === "song"
									? () => {
											const queue = section.items
												.slice(i + 1)
												.flatMap((next) =>
													next.kind === "song" ? [next.song] : [],
												);
											play(item.song, queue);
										}
									: item.kind === "artist"
										? () => navigate(`/artist/${item.id}`)
										: () => navigate(`/playlists/${item.id}`);
							const key = `${item.kind}-${item.kind === "song" ? item.song.id : item.id}-${i}`;
							if (item.kind === "song") {
								return (
									<SongContextMenu key={key} song={item.song}>
										<FeedCard item={item} onClick={onOpen} />
									</SongContextMenu>
								);
							}
							if (item.kind === "playlist" || item.kind === "album") {
								return (
									<PlaylistContextMenu
										isPinned={isPinned(item.id)}
										key={key}
										onDeleted={() => removeFeedItem(item.id)}
										onTogglePinned={() =>
											togglePinned({
												id: item.id,
												thumbnail: item.thumbnail,
												title: item.title,
											})
										}
										playlist={item}
									>
										<FeedCard item={item} onClick={onOpen} />
									</PlaylistContextMenu>
								);
							}
							return <FeedCard item={item} key={key} onClick={onOpen} />;
						})}
					</div>
				</section>
			))}
		</div>
	);
}
