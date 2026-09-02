import { useEffect, useState } from "react";
import { YTNodes } from "youtubei.js/web";
import { ArtistLinks } from "@/components/artist-link";
import { SongTitle } from "@/components/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { proxiedImageUrl } from "@/lib/tauri";
import { hiResThumb } from "@/lib/utils";
import { artistIdOf, artistListOf, artistNames } from "@/lib/youtube.utils";
import { getYoutubeClient } from "@/lib/youtube-client";

interface FeedSection {
	title: string;
	songs: Song[];
}

/**
 * Recommended songs from the YouTube Music home feed, rendered as
 * horizontally scrollable rows. Renders nothing while signed out.
 */
export function HomeFeed() {
	const { play } = usePlayer();
	const [sections, setSections] = useState<FeedSection[] | null>(null);
	const [failed, setFailed] = useState(false);

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
					const songs: Song[] = [];
					for (const item of section.contents ?? []) {
						if (item.is(YTNodes.MusicResponsiveListItem)) {
							songs.push({
								id: item.id ?? "",
								title: item.title ?? "Unknown Title",
								artist: artistNames(item),
								artistId: artistIdOf(item.artists),
								artists: artistListOf(item),
								thumbnail: hiResThumb(
									item.thumbnail?.contents?.[item.thumbnail.contents.length - 1]
										?.url,
								),
								duration: item.duration?.text,
							});
						} else if (
							item.is(YTNodes.MusicTwoRowItem) &&
							(item.item_type === "song" || item.item_type === "video")
						) {
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
							songs.push({
								id: item.id ?? "",
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
								thumbnail: hiResThumb(
									item.thumbnail?.[item.thumbnail.length - 1]?.url,
								),
								duration: undefined,
							});
						}
					}
					if (songs.length > 0) {
						out.push({ title, songs });
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
									<div className="shimmer-surface aspect-square w-44 rounded-xl" />
									<div className="shimmer-surface mt-2.5 h-4 w-32 rounded-md" />
									<div className="shimmer-surface mt-2 h-3 w-24 rounded-md" />
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

	return (
		<div>
			{sections.map((section, si) => (
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
						<span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
					</div>
					<div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
						{section.songs.map((song, i) => (
							<button
								className="group w-44 shrink-0 text-left"
								// biome-ignore lint/suspicious/noArrayIndexKey: feed may contain duplicate video ids
								key={`${song.id}-${i}`}
								onClick={() => play(song, section.songs.slice(i + 1))}
								type="button"
							>
								<div className="relative aspect-square overflow-hidden rounded-xl border border-foreground/8 bg-card">
									{song.thumbnail && (
										<img
											alt={song.title}
											className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
											loading="lazy"
											src={proxiedImageUrl(song.thumbnail)}
										/>
									)}
									<span className="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
										<svg
											aria-hidden
											className="size-4 translate-x-[1px] fill-current"
											viewBox="0 0 24 24"
										>
											<path d="M8 5.14v13.72c0 1.23 1.34 1.98 2.39 1.36l11.02-6.86a1.6 1.6 0 0 0 0-2.72L10.39 3.78C9.34 3.16 8 3.91 8 5.14Z" />
										</svg>
									</span>
								</div>
								<h3 className="mt-2.5 line-clamp-1 text-sm font-medium transition-colors group-hover:text-primary">
									<SongTitle artist={song.artist} title={song.title} />
								</h3>
								<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
									<ArtistLinks song={song} />
								</p>
							</button>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
