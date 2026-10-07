import { ContextMenu } from "@base-ui/react/context-menu";
import {
	Braces,
	CircleX,
	Download,
	FileText,
	Fingerprint,
	Image as ImageIcon,
	Languages,
	ListMusic,
	ListPlus,
	ListStart,
	type LucideIcon,
	MicVocal,
	Share2,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";
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
	const data = {
		...song,
		description,
		url: `https://music.youtube.com/watch?v=${song.id}`,
		length: seconds > 0 ? formatDuration(seconds) : undefined,
		lengthSeconds: seconds > 0 ? Math.round(seconds) : undefined,
		displayTitle: displayTitle(
			song.title,
			settings.titleMode,
			settings.cleanTitles,
			song.artist,
		),
		displayArtist: formatArtistName(song.artist),
		originalTitle: displayTitle(
			song.title,
			"original",
			settings.cleanTitles,
			song.artist,
		),
		parsedTitle: formatTitleParts(
			song.title,
			"original",
			settings.cleanTitles,
			song.artist,
		),
		tags: detectTitleTags(song.title),
	};
	await copyText(JSON.stringify(data, null, 2), "Song data");
}

function MenuItem({
	icon: Icon,
	label,
	onClick,
}: {
	icon: LucideIcon;
	label: string;
	onClick: () => void;
}) {
	return (
		<ContextMenu.Item
			className="flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none select-none data-highlighted:bg-foreground/8"
			onClick={onClick}
		>
			<Icon className="size-4 text-muted-foreground" />
			{label}
		</ContextMenu.Item>
	);
}

/**
 * Right-click (desktop) / long-press (touch) menu for a song row or card.
 * The trigger defaults to `display: contents` so wrapping rows and cards
 * doesn't disturb their layout.
 */
export function SongContextMenu({
	song,
	queueIndex,
	onRemove,
	removeLabel = "Remove from playlist",
	children,
	className = "contents",
}: {
	/** The song to act on; when absent the children render untouched. */
	song?: Song;
	/** Queue position, when the wrapped element is a queue row. */
	queueIndex?: number;
	/** Called by the "Remove" item, e.g. to delete the row from a playlist. */
	onRemove?: () => void;
	/** Label of the "Remove" item; defaults to the playlist wording. */
	removeLabel?: string;
	children: ReactNode;
	className?: string;
}) {
	const {
		addToQueue,
		play,
		playNext,
		removeFromQueueAt,
		queue,
		currentSong,
		duration: playerDuration,
	} = usePlayer();
	const [settings] = useSettings();
	const downloads = useDownloads();
	const [playlistSong, setPlaylistSong] = useState<Song | null>(null);
	const navigate = useNavigate();

	if (!song) return <>{children}</>;

	const downloadEntry = downloads.entries.get(song.id);
	const downloadStatus = downloads.statuses.get(song.id);

	return (
		<>
			<ContextMenu.Root>
				<ContextMenu.Trigger
					className={cn("context-menu-highlight", className)}
				>
					{children}
				</ContextMenu.Trigger>
				<ContextMenu.Portal>
					<ContextMenu.Positioner className="z-90 outline-none" sideOffset={6}>
						<ContextMenu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl border border-foreground/10 bg-popover p-1 text-popover-foreground shadow-xl outline-none transition-[transform,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
							<MenuItem
								icon={ListStart}
								label="Play next"
								onClick={() => {
									playNext(song);
									showToast("Playing next");
								}}
							/>
							<MenuItem
								icon={ListPlus}
								label="Add to queue"
								onClick={() => {
									// Nothing playing and nothing queued: there is no
									// queue to add behind, so start the song instead.
									if (!currentSong && queue.length === 0) {
										play(song);
										return;
									}
									addToQueue([song]);
									showToast("Added to queue");
								}}
							/>
							<MenuItem
								icon={ListMusic}
								label="Add to playlist"
								onClick={() => setPlaylistSong(song)}
							/>
							{downloadEntry ? (
								<MenuItem
									icon={Trash2}
									label="Remove download"
									onClick={() => void removeDownloads([song.id])}
								/>
							) : downloadStatus &&
								(downloadStatus.phase === "downloading" ||
									downloadStatus.phase === "queued") ? (
								<MenuItem
									icon={CircleX}
									label={
										downloadStatus.phase === "downloading" &&
										downloadStatus.progress !== null
											? `Cancel download (${Math.round(downloadStatus.progress * 100)}%)`
											: "Cancel download"
									}
									onClick={() => cancelDownload(song.id)}
								/>
							) : (
								<MenuItem
									icon={Download}
									label={
										downloadStatus?.phase === "error"
											? "Retry download"
											: "Download"
									}
									onClick={() => downloadSong(song)}
								/>
							)}
							<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
							{song.artistId && (
								<MenuItem
									icon={MicVocal}
									label="Go to artist"
									onClick={() => navigate(`/artist/${song.artistId}`)}
								/>
							)}
							<MenuItem
								icon={Share2}
								label="Share song"
								onClick={() => void shareSong(song)}
							/>
							{(onRemove || queueIndex !== undefined) && (
								<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
							)}
							{onRemove && (
								<MenuItem
									icon={Trash2}
									label={removeLabel}
									onClick={onRemove}
								/>
							)}
							{queueIndex !== undefined && (
								<MenuItem
									icon={Trash2}
									label="Remove from queue"
									onClick={() => removeFromQueueAt(queueIndex)}
								/>
							)}
							{settings.developerMode && (
								<>
									<ContextMenu.Separator className="my-1 h-px bg-foreground/8" />
									<ContextMenu.Group>
										<ContextMenu.GroupLabel className="px-2.5 pt-1.5 pb-0.5 font-mono text-[10px] font-medium tracking-[0.18em] text-muted-foreground/70 uppercase select-none">
											Developer
										</ContextMenu.GroupLabel>
										<MenuItem
											icon={Languages}
											label="Copy original title"
											onClick={() =>
												void copyText(
													displayTitle(
														song.title,
														"original",
														settings.cleanTitles,
														song.artist,
													),
													"Original title",
												)
											}
										/>
										<MenuItem
											icon={FileText}
											label="Copy raw title"
											onClick={() => void copyText(song.title, "Raw title")}
										/>
										<MenuItem
											icon={Fingerprint}
											label="Copy video ID"
											onClick={() => void copyText(song.id, "Video ID")}
										/>
										<MenuItem
											icon={ImageIcon}
											label="Copy thumbnail URL"
											onClick={() =>
												void copyText(song.thumbnail, "Thumbnail URL")
											}
										/>
										<MenuItem
											icon={Braces}
											label="Copy song data"
											onClick={() =>
												void copySongData(
													song,
													settings,
													currentSong?.id === song.id ? playerDuration : 0,
												)
											}
										/>
									</ContextMenu.Group>
								</>
							)}
						</ContextMenu.Popup>
					</ContextMenu.Positioner>
				</ContextMenu.Portal>
			</ContextMenu.Root>
			<AddToPlaylistDialog
				onOpenChange={(open) => {
					if (!open) setPlaylistSong(null);
				}}
				open={playlistSong !== null}
				song={playlistSong}
			/>
		</>
	);
}
