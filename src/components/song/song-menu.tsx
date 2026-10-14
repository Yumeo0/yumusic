import { ContextMenu } from "@kobalte/core/context-menu";
import {
	Braces,
	CircleX,
	Download,
	FileText,
	Fingerprint,
	ImageIcon,
	Languages,
	ListMusic,
	ListPlus,
	ListStart,
	type LucideIcon,
	MicVocal,
	Share2,
	Trash2,
} from "@lucide/solid";
import { useNavigate } from "@solidjs/router";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { Song } from "@/contexts/player-context";
import { usePlayer } from "@/contexts/player-context";
import {
	cancelDownload,
	downloadSong,
	removeDownloads,
	useDownloads,
} from "@/lib/downloads/downloads";
import { shareSong } from "@/lib/services/share";
import { type Settings, useSettings } from "@/lib/stores/settings";
import { showToast } from "@/lib/stores/toast";
import {
	detectTitleTags,
	displayTitle,
	formatArtistName,
	formatTitleParts,
} from "@/lib/utils/title";
import { cn, formatDuration, parseDuration } from "@/lib/utils/utils";
import { fetchSongDescription } from "@/lib/youtube/song-description";
import { AddToPlaylistDialog } from "./add-to-playlist-dialog";

/** Copies text to the clipboard and reports the result as a toast. */
async function copyText(text: string, label: string) {
	try {
		await navigator.clipboard.writeText(text);
		showToast(`${label} copied`);
	} catch {
		showToast(`Could not copy ${label.toLowerCase()}`);
	}
}

/**
 * Copies the song as JSON for bug reports. Besides the raw fields it carries
 * what the app derives from them — the YouTube Music link, length (label and
 * seconds), the titles it displays (current mode and original language), the
 * title parser's output (main title, feats, credits, cover artists), tags and
 * the formatted artist name. The uploader description is included — fetched on
 * demand when the song wasn't enriched yet, so pasted reports carry the same
 * data the title parser sees.
 */
async function copySongData(
	song: Song,
	settings: Settings,
	/** Player's length in seconds, when this is the current song. */
	knownDuration = 0,
) {
	const description =
		song.description ?? (await fetchSongDescription(song.id)) ?? undefined;
	const seconds =
		knownDuration > 0 ? knownDuration : parseDuration(song.duration);
	// Uploader videos keep their raw title: no dual-language parsing applies.
	const mode = song.upload ? "both" : settings.titleMode;
	const originalMode = song.upload ? "both" : "original";
	const data = {
		...song,
		description,
		url: `https://music.youtube.com/watch?v=${song.id}`,
		length: seconds > 0 ? formatDuration(seconds) : undefined,
		lengthSeconds: seconds > 0 ? Math.round(seconds) : undefined,
		displayTitle: displayTitle(
			song.title,
			mode,
			settings.cleanTitles,
			song.artist,
		),
		displayArtist: formatArtistName(song.artist),
		originalTitle: displayTitle(
			song.title,
			originalMode,
			settings.cleanTitles,
			song.artist,
		),
		parsedTitle: formatTitleParts(
			song.title,
			originalMode,
			settings.cleanTitles,
			song.artist,
		),
		tags: detectTitleTags(song.title),
	};
	await copyText(JSON.stringify(data, null, 2), "Song data");
}

function MenuItem(props: {
	icon: LucideIcon;
	label: string;
	onClick: () => void;
}) {
	return (
		<ContextMenu.Item
			class="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
			onClick={props.onClick}
		>
			<props.icon class="size-4 text-muted-foreground" />
			{props.label}
		</ContextMenu.Item>
	);
}

/**
 * Right-click (desktop) / long-press (touch) menu for a song row or card.
 * The trigger defaults to `display: contents` so wrapping rows and cards
 * doesn't disturb their layout.
 */
export function SongContextMenu(props: {
	/** The song to act on; when absent the children render untouched. */
	song?: Song;
	/** Queue position, when the wrapped element is a queue row. */
	queueIndex?: number;
	/** Called by the "Remove" item, e.g. to delete the row from a playlist. */
	onRemove?: () => void;
	/** Label of the "Remove" item; defaults to the playlist wording. */
	removeLabel?: string;
	children: JSX.Element;
	class?: string;
}) {
	const player = usePlayer();
	const [settings] = useSettings();
	const downloads = useDownloads();
	const [playlistSong, setPlaylistSong] = createSignal<Song | null>(null);
	const navigate = useNavigate();

	return (
		<Show fallback={props.children} when={props.song}>
			{(song) => {
				const downloadEntry = () => downloads.entries.get(song().id);
				const downloadStatus = () => downloads.statuses.get(song().id);
				return (
					<>
						<ContextMenu>
							<ContextMenu.Trigger
								class={cn("context-menu-highlight", props.class ?? "contents")}
							>
								{props.children}
							</ContextMenu.Trigger>
							<ContextMenu.Portal>
								<ContextMenu.Content class="z-90 min-w-44 origin-(--kb-menu-content-transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-[closed]:scale-95 data-[closed]:opacity-0">
									<MenuItem
										icon={ListStart}
										label="Play next"
										onClick={() => {
											player.playNext(song());
											showToast("Playing next");
										}}
									/>
									<MenuItem
										icon={ListPlus}
										label="Add to queue"
										onClick={() => {
											// Nothing playing and nothing queued: there is no
											// queue to add behind, so start the song instead.
											if (
												!player.currentSong() &&
												player.queue().length === 0
											) {
												void player.play(song());
												return;
											}
											player.addToQueue([song()]);
											showToast("Added to queue");
										}}
									/>
									<MenuItem
										icon={ListMusic}
										label="Add to playlist"
										onClick={() => setPlaylistSong(song())}
									/>
									<Show
										fallback={
											<Show
												fallback={
													<MenuItem
														icon={Download}
														label={
															downloadStatus()?.phase === "error"
																? "Retry download"
																: "Download"
														}
														onClick={() => downloadSong(song())}
													/>
												}
												when={
													downloadStatus() &&
													(downloadStatus()?.phase === "downloading" ||
														downloadStatus()?.phase === "queued")
												}
											>
												<MenuItem
													icon={CircleX}
													label={(() => {
														const status = downloadStatus();
														return status?.phase === "downloading" &&
															status.progress !== null
															? `Cancel download (${Math.round(status.progress * 100)}%)`
															: "Cancel download";
													})()}
													onClick={() => cancelDownload(song().id)}
												/>
											</Show>
										}
										when={downloadEntry()}
									>
										<MenuItem
											icon={Trash2}
											label="Remove download"
											onClick={() => void removeDownloads([song().id])}
										/>
									</Show>
									<ContextMenu.Separator class="my-1 h-px bg-foreground/8" />
									<Show when={song().artistId}>
										{(artistId) => (
											<MenuItem
												icon={MicVocal}
												label="Go to artist"
												onClick={() => navigate(`/artist/${artistId()}`)}
											/>
										)}
									</Show>
									<MenuItem
										icon={Share2}
										label="Share song"
										onClick={() => void shareSong(song())}
									/>
									<Show when={props.onRemove || props.queueIndex !== undefined}>
										<ContextMenu.Separator class="my-1 h-px bg-foreground/8" />
									</Show>
									<Show when={props.onRemove}>
										{(onRemove) => (
											<MenuItem
												icon={Trash2}
												label={props.removeLabel ?? "Remove from playlist"}
												onClick={onRemove()}
											/>
										)}
									</Show>
									<Show when={props.queueIndex !== undefined}>
										<MenuItem
											icon={Trash2}
											label="Remove from queue"
											onClick={() =>
												player.removeFromQueueAt(props.queueIndex ?? 0)
											}
										/>
									</Show>
									<Show when={settings.developerMode}>
										<ContextMenu.Separator class="my-1 h-px bg-foreground/8" />
										<ContextMenu.Group>
											<ContextMenu.GroupLabel class="px-2.5 pt-1.5 pb-0.5 font-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase select-none">
												Developer
											</ContextMenu.GroupLabel>
											<MenuItem
												icon={Languages}
												label="Copy original title"
												onClick={() =>
													void copyText(
														displayTitle(
															song().title,
															song().upload ? "both" : "original",
															settings.cleanTitles,
															song().artist,
														),
														"Original title",
													)
												}
											/>
											<MenuItem
												icon={FileText}
												label="Copy raw title"
												onClick={() => void copyText(song().title, "Raw title")}
											/>
											<MenuItem
												icon={Fingerprint}
												label="Copy video ID"
												onClick={() => void copyText(song().id, "Video ID")}
											/>
											<MenuItem
												icon={ImageIcon}
												label="Copy thumbnail URL"
												onClick={() =>
													void copyText(song().thumbnail, "Thumbnail URL")
												}
											/>
											<MenuItem
												icon={Braces}
												label="Copy song data"
												onClick={() =>
													void copySongData(
														song(),
														settings,
														player.currentSong()?.id === song().id
															? player.duration()
															: 0,
													)
												}
											/>
										</ContextMenu.Group>
									</Show>
								</ContextMenu.Content>
							</ContextMenu.Portal>
						</ContextMenu>
						<AddToPlaylistDialog
							onOpenChange={(open) => {
								if (!open) setPlaylistSong(null);
							}}
							open={playlistSong() !== null}
							song={playlistSong()}
						/>
					</>
				);
			}}
		</Show>
	);
}
