import { Dialog } from "@kobalte/core/dialog";
import { ListMusic, Loader2, Plus, Search, X } from "@lucide/solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Input } from "@/components/ui/input";
import type { Song } from "@/contexts/player-context";
import {
	addSongToCachedPlaylist,
	invalidateLibraryCache,
} from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";
import {
	addSongToPlaylist,
	createPlaylist,
	getLibraryPlaylists,
	type LibraryPlaylist,
} from "@/lib/youtube/youtube-client";

/**
 * Modal for adding a song to one of the user's playlists, with an inline
 * "new playlist" flow. Playlists are fetched once per session and the chosen
 * playlist's cached tracklist is updated in place so the new song shows up
 * without a refetch.
 */
export function AddToPlaylistDialog(props: {
	/** The song to add; nothing renders while it is null. */
	song: Song | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [playlists, setPlaylists] = createSignal<LibraryPlaylist[] | null>(
		null,
	);
	const [failed, setFailed] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const [creating, setCreating] = createSignal(false);
	const [newTitle, setNewTitle] = createSignal("");
	/** Playlist id (or "new") currently being written to. */
	const [busy, setBusy] = createSignal<string | null>(null);

	// Reload (from the session cache) whenever the dialog opens.
	createEffect(
		() => props.open,
		(isOpen) => {
			if (!isOpen) return;
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
		},
	);

	const addTo = async (playlist: LibraryPlaylist) => {
		const song = props.song;
		if (!song || busy() !== null) return;
		setBusy(playlist.id);
		try {
			await addSongToPlaylist(playlist.id, song.id);
			addSongToCachedPlaylist(playlist.id, song);
			showToast(`Added to ${playlist.title}`);
			props.onOpenChange(false);
		} catch (error) {
			console.error("[YuMusic] add to playlist failed:", error);
			showToast(`Could not add to ${playlist.title}`);
		} finally {
			setBusy(null);
		}
	};

	const submitNew = async (event: SubmitEvent) => {
		event.preventDefault();
		const title = newTitle().trim();
		const song = props.song;
		if (!song || !title || busy() !== null) return;
		setBusy("new");
		try {
			await createPlaylist(title, song.id);
			invalidateLibraryCache();
			showToast(`Added to ${title}`);
			props.onOpenChange(false);
		} catch (error) {
			console.error("[YuMusic] create playlist failed:", error);
			showToast(`Could not create ${title}`);
		} finally {
			setBusy(null);
		}
	};

	const filtered = createMemo(() => {
		const needle = query().trim().toLowerCase();
		return (
			playlists()?.filter(
				(playlist) => !needle || playlist.title.toLowerCase().includes(needle),
			) ?? []
		);
	});

	return (
		<Dialog onOpenChange={props.onOpenChange} open={props.open}>
			<Dialog.Portal>
				<Dialog.Overlay class="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-[closed]:opacity-0" />
				<Dialog.Content class="fixed top-1/2 left-1/2 z-100 flex max-h-[min(32rem,80vh)] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-[closed]:scale-95 data-[closed]:opacity-0">
					<div class="flex items-start justify-between gap-4 border-b border-foreground/8 p-4">
						<div class="min-w-0">
							<Dialog.Title class="text-sm font-semibold">
								Add to playlist
							</Dialog.Title>
							<Show when={props.song}>
								{(song) => (
									<p class="mt-0.5 truncate text-xs text-muted-foreground">
										{song().title}
									</p>
								)}
							</Show>
						</div>
						<Dialog.CloseButton
							aria-label="Close"
							class="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						>
							<X class="size-4" />
						</Dialog.CloseButton>
					</div>

					<div class="border-b border-foreground/8 p-2">
						<Show
							fallback={
								<button
									class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 hover:bg-foreground/8"
									onClick={() => setCreating(true)}
									type="button"
								>
									<Plus class="size-4 text-muted-foreground" />
									New playlist
								</button>
							}
							when={creating()}
						>
							<form class="flex gap-2 p-0.5" onSubmit={submitNew}>
								<Input
									class="h-9"
									maxlength={80}
									onInput={(event) => {
										setNewTitle(event.target.value);
									}}
									placeholder="Playlist name"
									value={newTitle()}
								/>
								<button
									class="h-9 shrink-0 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
									disabled={!newTitle().trim() || busy() !== null}
									type="submit"
								>
									Create
								</button>
							</form>
						</Show>
					</div>

					<Show when={(playlists()?.length ?? 0) > 6}>
						<div class="relative border-b border-foreground/8 p-3">
							<Search class="absolute top-1/2 left-5.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
							<Input
								class="h-8 pl-8"
								onInput={(event) => {
									setQuery(event.target.value);
								}}
								placeholder="Search playlists"
								value={query()}
							/>
						</div>
					</Show>

					<div class="min-h-0 flex-1 overflow-y-auto p-1.5">
						<Show when={playlists() === null && !failed()}>
							<p class="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
								<Loader2 class="size-3.5 animate-spin" />
								Loading playlists…
							</p>
						</Show>
						<Show when={failed()}>
							<p class="px-4 py-10 text-center text-xs text-muted-foreground">
								Couldn't load your playlists. Make sure you're logged in.
							</p>
						</Show>
						<Show when={playlists()?.length === 0 && !failed()}>
							<p class="px-4 py-10 text-center text-xs text-muted-foreground">
								No playlists yet — create one above.
							</p>
						</Show>
						<For each={filtered()}>
							{(playlist) => (
								<button
									class="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/8 disabled:pointer-events-none disabled:opacity-50"
									disabled={busy() !== null}
									onClick={() => void addTo(playlist)}
									type="button"
								>
									<Show
										fallback={
											<div class="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
												<ListMusic class="size-4 text-muted-foreground" />
											</div>
										}
										when={playlist.thumbnail}
									>
										{(thumbnail) => (
											<img
												alt=""
												class="size-9 shrink-0 rounded-md border border-foreground/8 object-cover"
												loading="lazy"
												src={proxiedImageUrl(thumbnail())}
											/>
										)}
									</Show>
									<span
										class={cn(
											"min-w-0 flex-1 truncate text-sm",
											busy() === playlist.id && "text-muted-foreground",
										)}
									>
										{playlist.title}
									</span>
									<Show when={busy() === playlist.id}>
										<Loader2 class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
									</Show>
								</button>
							)}
						</For>
						<Show
							when={
								playlists() !== null &&
								(playlists()?.length ?? 0) > 0 &&
								filtered().length === 0
							}
						>
							<p class="px-4 py-10 text-center text-xs text-muted-foreground">
								No playlists match "{query().trim()}".
							</p>
						</Show>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}
