import { Dialog } from "@base-ui/react/dialog";
import { ListMusic, Loader2, Plus, Search, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import type { Song } from "@/contexts/player-context";
import { clearPlaylistCache } from "@/lib/playlist-cache";
import { proxiedImageUrl } from "@/lib/tauri";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
	addSongToPlaylist,
	createPlaylist,
	getLibraryPlaylists,
	type LibraryPlaylist,
} from "@/lib/youtube-client";

/**
 * Modal for adding a song to one of the user's playlists, with an inline
 * "new playlist" flow. Playlists are fetched once per session and the chosen
 * playlist's cached tracklist is dropped so the new song shows up.
 */
export function AddToPlaylistDialog({
	song,
	open,
	onOpenChange,
}: {
	/** The song to add; nothing renders while it is null. */
	song: Song | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [playlists, setPlaylists] = useState<LibraryPlaylist[] | null>(null);
	const [failed, setFailed] = useState(false);
	const [query, setQuery] = useState("");
	const [creating, setCreating] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	/** Playlist id (or "new") currently being written to. */
	const [busy, setBusy] = useState<string | null>(null);

	// Reload (from the session cache) whenever the dialog opens.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setCreating(false);
		setNewTitle("");
		setFailed(false);
		setPlaylists(null);
		setBusy(null);
		let cancelled = false;
		getLibraryPlaylists()
			.then((list) => {
				if (!cancelled) setPlaylists(list);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const addTo = async (playlist: LibraryPlaylist) => {
		if (!song || busy !== null) return;
		setBusy(playlist.id);
		try {
			await addSongToPlaylist(playlist.id, song.id);
			clearPlaylistCache(playlist.id);
			showToast(`Added to ${playlist.title}`);
			onOpenChange(false);
		} catch (error) {
			console.error("[YuMusic] add to playlist failed:", error);
			showToast(`Could not add to ${playlist.title}`);
		} finally {
			setBusy(null);
		}
	};

	const submitNew = async (event: FormEvent) => {
		event.preventDefault();
		const title = newTitle.trim();
		if (!song || !title || busy !== null) return;
		setBusy("new");
		try {
			const id = await createPlaylist(title, song.id);
			if (id) clearPlaylistCache(id);
			showToast(`Added to ${title}`);
			onOpenChange(false);
		} catch (error) {
			console.error("[YuMusic] create playlist failed:", error);
			showToast(`Could not create ${title}`);
		} finally {
			setBusy(null);
		}
	};

	const needle = query.trim().toLowerCase();
	const filtered =
		playlists?.filter(
			(playlist) => !needle || playlist.title.toLowerCase().includes(needle),
		) ?? [];

	return (
		<Dialog.Root onOpenChange={onOpenChange} open={open}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 flex max-h-[min(32rem,80vh)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
					<div className="flex items-start justify-between gap-4 border-b border-foreground/8 p-4">
						<div className="min-w-0">
							<Dialog.Title className="text-sm font-semibold">
								Add to playlist
							</Dialog.Title>
							{song && (
								<p className="mt-0.5 truncate text-xs text-muted-foreground">
									{song.title}
								</p>
							)}
						</div>
						<Dialog.Close
							aria-label="Close"
							className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						>
							<X className="size-4" />
						</Dialog.Close>
					</div>

					<div className="border-b border-foreground/8 p-2">
						{creating ? (
							<form className="flex gap-2 p-0.5" onSubmit={submitNew}>
								<Input
									className="h-9"
									maxLength={80}
									onChange={(event) => setNewTitle(event.target.value)}
									placeholder="Playlist name"
									value={newTitle}
								/>
								<button
									className="h-9 shrink-0 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
									disabled={!newTitle.trim() || busy !== null}
									type="submit"
								>
									Create
								</button>
							</form>
						) : (
							<button
								className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 hover:bg-foreground/8"
								onClick={() => setCreating(true)}
								type="button"
							>
								<Plus className="size-4 text-muted-foreground" />
								New playlist
							</button>
						)}
					</div>

					{playlists !== null && playlists.length > 6 && (
						<div className="relative border-b border-foreground/8 p-3">
							<Search className="absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								className="h-8 pl-8"
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search playlists"
								value={query}
							/>
						</div>
					)}

					<div className="min-h-0 flex-1 overflow-y-auto p-1.5">
						{playlists === null && !failed && (
							<p className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
								<Loader2 className="size-3.5 animate-spin" />
								Loading playlists…
							</p>
						)}
						{failed && (
							<p className="px-4 py-10 text-center text-xs text-muted-foreground">
								Couldn't load your playlists. Make sure you're logged in.
							</p>
						)}
						{playlists?.length === 0 && !failed && (
							<p className="px-4 py-10 text-center text-xs text-muted-foreground">
								No playlists yet — create one above.
							</p>
						)}
						{filtered.map((playlist) => (
							<button
								className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/8 disabled:pointer-events-none disabled:opacity-50"
								disabled={busy !== null}
								key={playlist.id}
								onClick={() => void addTo(playlist)}
								type="button"
							>
								{playlist.thumbnail ? (
									<img
										alt=""
										className="size-9 shrink-0 rounded-md border border-foreground/8 object-cover"
										loading="lazy"
										src={proxiedImageUrl(playlist.thumbnail)}
									/>
								) : (
									<div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
										<ListMusic className="size-4 text-muted-foreground" />
									</div>
								)}
								<span
									className={cn(
										"min-w-0 flex-1 truncate text-sm",
										busy === playlist.id && "text-muted-foreground",
									)}
								>
									{playlist.title}
								</span>
								{busy === playlist.id && (
									<Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
								)}
							</button>
						))}
						{playlists !== null &&
							playlists.length > 0 &&
							filtered.length === 0 && (
								<p className="px-4 py-10 text-center text-xs text-muted-foreground">
									No playlists match "{query.trim()}".
								</p>
							)}
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
