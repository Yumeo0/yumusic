import { ArrowUpRight, Disc3, ListMusic } from "@lucide/solid";
import { useNavigate } from "@solidjs/router";
import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { YTNodes } from "youtubei.js/web";
import { PlaylistContextMenu } from "@/components/playlist/playlist-menu";
import { ArtistLinks } from "@/components/song/artist-link";
import { DownloadedBadge } from "@/components/song/downloaded-badge";
import { SongContextMenu } from "@/components/song/song-menu";
import { SongTitle } from "@/components/song/song-title";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import { usePinnedPlaylists } from "@/lib/stores/pinned";
import { useSettings } from "@/lib/stores/settings";
import { useSongVersionReplacements } from "@/lib/stores/song-versions";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { formatArtistName } from "@/lib/utils/title";
import {
	biggestThumb,
	cn,
	hiResThumb,
	type ThumbCandidate,
} from "@/lib/utils/utils";
import {
	enrichSongsWithDescriptions,
	enrichSongsWithUploads,
} from "@/lib/youtube/song-description";
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

function FeedCard(props: { item: FeedItem; onClick: () => void }) {
	const isArtist = () => props.item.kind === "artist";
	const title = () => {
		const item = props.item;
		if (item.kind === "song") return item.song.title;
		if (item.kind === "artist") return formatArtistName(item.name);
		return item.title;
	};
	const subtitle = () => {
		const item = props.item;
		return item.kind === "song" ? item.song.artist : item.subtitle;
	};
	const thumbnail = () => {
		const item = props.item;
		return item.kind === "song" ? item.song.thumbnail : item.thumbnail;
	};

	return (
		<button
			class={cn(
				"group w-32 shrink-0 text-left md:w-44",
				isArtist() && "text-center",
			)}
			onClick={props.onClick}
			type="button"
		>
			<div
				class={cn(
					"relative aspect-square overflow-hidden border border-foreground/8 bg-card",
					isArtist() ? "rounded-full" : "rounded-xl",
				)}
			>
				<Show when={thumbnail()}>
					{(src) => (
						<img
							alt={title()}
							class="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
							loading="lazy"
							src={proxiedImageUrl(src())}
						/>
					)}
				</Show>
				<Show
					when={props.item.kind === "playlist" || props.item.kind === "album"}
				>
					<span class="pointer-events-none absolute bottom-2 left-2 grid size-7 place-items-center rounded-md bg-black/60 text-white shadow-sm backdrop-blur-xs">
						<Show
							fallback={<Disc3 class="size-4" />}
							when={props.item.kind === "playlist"}
						>
							<ListMusic class="size-4" />
						</Show>
					</span>
				</Show>
				<Show
					fallback={
						<span class="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
							<ArrowUpRight class="size-4" />
						</span>
					}
					when={props.item.kind === "song"}
				>
					<span class="absolute right-2.5 bottom-2.5 grid size-9 translate-y-2 place-items-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100">
						<svg
							aria-hidden="true"
							class="size-4 translate-x-px fill-current"
							viewBox="0 0 24 24"
						>
							<path d="M8 5.14v13.72c0 1.23 1.34 1.98 2.39 1.36l11.02-6.86a1.6 1.6 0 0 0 0-2.72L10.39 3.78C9.34 3.16 8 3.91 8 5.14Z" />
						</svg>
					</span>
				</Show>
			</div>
			<h3 class="mt-2.5 flex items-center gap-1.5 text-sm font-medium transition-colors group-hover:text-primary">
				<span class="line-clamp-1 min-w-0">
					<Show
						fallback={title()}
						when={props.item.kind === "song" ? props.item : null}
					>
						{(song) => (
							<SongTitle
								artist={song().song.artist}
								keepTitle={song().song.upload}
								title={song().song.title}
							/>
						)}
					</Show>
				</span>
				<Show when={props.item.kind === "song" ? props.item : null}>
					{(song) => <DownloadedBadge songId={song().song.id} />}
				</Show>
			</h3>
			<p
				class={cn(
					"mt-0.5 line-clamp-1 text-xs text-muted-foreground",
					isArtist() && "text-center",
				)}
			>
				<Show
					fallback={subtitle()}
					when={props.item.kind === "song" ? props.item : null}
				>
					{(song) => <ArtistLinks song={song().song} />}
				</Show>
			</p>
		</button>
	);
}

/** Every playable song in the feed, for the description prefetch. */
function feedSongs(sections: FeedSection[]): Song[] {
	return sections.flatMap((section) =>
		section.items.flatMap((item) => (item.kind === "song" ? [item.song] : [])),
	);
}

/** Replaces one song wherever it appears in the feed. Sections and items that
 * are not affected keep their identity, so `<For>` reuses their DOM. */
function withUpdatedSong(
	sections: FeedSection[],
	updated: Song,
): FeedSection[] {
	let anyChanged = false;
	const next = sections.map((section) => {
		let sectionChanged = false;
		const items = section.items.map((item) => {
			if (item.kind === "song" && item.song.id === updated.id) {
				sectionChanged = true;
				return { ...item, song: updated };
			}
			return item;
		});
		if (!sectionChanged) return section;
		anyChanged = true;
		return { ...section, items };
	});
	return anyChanged ? next : sections;
}

/**
 * Recommended tracks, playlists, albums and artists from the YouTube Music
 * home feed, rendered as horizontally scrollable rows. Renders nothing while
 * signed out.
 */
export function HomeFeed() {
	const player = usePlayer();
	const navigate = useNavigate();
	const [settings] = useSettings();
	const { isPinned, togglePinned } = usePinnedPlaylists();
	const [sections, setSections] = createSignal<FeedSection[] | null>(null);
	const [failed, setFailed] = createSignal(false);
	// Description prefetch: uploader descriptions carry the real song credits
	// ("Singer: X / Song: Y") and resolve the ambiguous titles the raw
	// pipeline leaves alone. Rows update as each description lands.
	let enrichCancel: (() => void) | null = null;
	let uploadCancel: (() => void) | null = null;
	// Video cards already resolved to their song version while playing.
	const versions = useSongVersionReplacements();

	const removeFeedItem = (id: string) => {
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
	};

	onSettled(() => {
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
				// Read at prefetch start; whatever is playing gets its
				// description from the player response, so fetching it here
				// would be a duplicate request.
				const playingId = player.currentSong()?.id;
				const applyUpdatedSong = (updated: Song): void => {
					setSections((prev) => (prev ? withUpdatedSong(prev, updated) : prev));
				};
				enrichCancel = enrichSongsWithDescriptions(
					feedSongs(out),
					applyUpdatedSong,
					playingId ? new Set([playingId]) : undefined,
				);
				// Reuploads (no release) keep their raw titles; the player
				// marks what it plays, this covers the rest of the feed.
				uploadCancel = enrichSongsWithUploads(feedSongs(out), applyUpdatedSong);
			} catch (error) {
				console.warn("[HomeFeed] failed to load recommendations:", error);
				if (cancelled) return;
				setSections([]);
				setFailed(true);
			}
		})();
		return () => {
			cancelled = true;
			enrichCancel?.();
			uploadCancel?.();
		};
	});

	const visibleSections = createMemo(() =>
		(sections() ?? []).filter(
			(section) =>
				!(
					settings.hideTodaysBiggestHits && isHiddenSectionTitle(section.title)
				),
		),
	);

	return (
		<Show
			fallback={
				<div class="space-y-10">
					<For each={[0, 1]}>
						{() => (
							<div>
								<div class="shimmer-surface mb-4 h-4 w-40 rounded-md" />
								<div class="flex gap-4">
									<For each={[0, 1, 2, 3, 4]}>
										{() => (
											<div>
												<div class="shimmer-surface aspect-square w-32 rounded-xl md:w-44" />
												<div class="shimmer-surface mt-2.5 h-4 w-24 rounded-md md:w-32" />
												<div class="shimmer-surface mt-2 h-3 w-16 rounded-md md:w-24" />
											</div>
										)}
									</For>
								</div>
							</div>
						)}
					</For>
				</div>
			}
			when={sections() !== null}
		>
			<Show
				fallback={
					<p class="text-sm text-muted-foreground/70">
						Recommendations unavailable — log in to see your mix.
					</p>
				}
				when={!failed()}
			>
				<div>
					<For each={visibleSections()}>
						{(section, si) => (
							<section
								class="animate-track-in pb-3"
								style={{ "animation-delay": `${si() * 80}ms` }}
							>
								<div class="mb-4 flex items-center gap-2">
									<h2 class="text-sm font-medium text-muted-foreground">
										{section.title}
									</h2>
									<span class="h-px flex-1 bg-linear-to-r from-border to-transparent" />
								</div>
								<div class="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2">
									<For each={section.items}>
										{(item, i) => {
											// A video resolved to its album track while playing
											// is shown and played as that song.
											const song = () =>
												item.kind === "song"
													? (versions.get(item.song.id) ?? item.song)
													: null;
											const onOpen =
												item.kind === "song"
													? () => {
															const upcoming = section.items
																.slice(i() + 1)
																.flatMap((next) =>
																	next.kind === "song" ? [next.song] : [],
																);
															void player.play(song() ?? item.song, upcoming);
														}
													: item.kind === "artist"
														? () => navigate(`/artist/${item.id}`)
														: () => navigate(`/playlists/${item.id}`);
											return (
												<Show
													fallback={
														item.kind === "playlist" ||
														item.kind === "album" ? (
															<PlaylistContextMenu
																isPinned={isPinned(item.id)}
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
														) : (
															<FeedCard item={item} onClick={onOpen} />
														)
													}
													when={item.kind === "song" ? item : null}
												>
													{(playable) => (
														<SongContextMenu song={song() ?? playable().song}>
															<FeedCard
																item={{
																	...playable(),
																	song: song() ?? playable().song,
																}}
																onClick={onOpen}
															/>
														</SongContextMenu>
													)}
												</Show>
											);
										}}
									</For>
								</div>
							</section>
						)}
					</For>
				</div>
			</Show>
		</Show>
	);
}
