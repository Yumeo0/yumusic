import { Dialog } from "@kobalte/core/dialog";
import { Loader2 } from "@lucide/solid";
import { createSignal, Show } from "solid-js";
import { unsubscribeDownloadedPlaylist } from "@/lib/downloads/downloads";
import { removePlaylistFromCaches } from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { deletePlaylist } from "@/lib/youtube/youtube-client";

export function ConfirmDeletePlaylistDialog(props: {
	playlistId: string;
	playlistTitle: string;
	isPinned: boolean;
	onTogglePinned: () => void;
	onDeleted?: () => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [busy, setBusy] = createSignal(false);

	const confirmDelete = async () => {
		if (busy()) return;
		setBusy(true);
		try {
			await deletePlaylist(props.playlistId);
			removePlaylistFromCaches(props.playlistId);
			unsubscribeDownloadedPlaylist(props.playlistId);
			if (props.isPinned) props.onTogglePinned();
			props.onOpenChange(false);
			showToast("Playlist deleted");
			props.onDeleted?.();
		} catch (error) {
			console.error("[YuMusic] delete playlist failed:", error);
			showToast("Could not delete playlist");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog onOpenChange={props.onOpenChange} open={props.open}>
			<Dialog.Portal>
				<Dialog.Overlay class="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-[closed]:opacity-0" />
				<Dialog.Content class="fixed top-1/2 left-1/2 z-100 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-foreground/10 bg-popover p-5 text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-[closed]:scale-95 data-[closed]:opacity-0">
					<Dialog.Title class="text-base font-semibold">
						Delete playlist?
					</Dialog.Title>
					<Dialog.Description class="mt-1.5 text-sm text-muted-foreground">
						"{props.playlistTitle}" will be permanently deleted from your
						YouTube Music library.
					</Dialog.Description>
					<div class="mt-5 flex justify-end gap-2">
						<Dialog.CloseButton class="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
							Cancel
						</Dialog.CloseButton>
						<button
							class="flex items-center gap-2 rounded-lg bg-destructive px-3.5 py-2 text-sm font-semibold text-destructive-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
							disabled={busy()}
							onClick={() => void confirmDelete()}
							type="button"
						>
							<Show when={busy()}>
								<Loader2 class="size-3.5 animate-spin" />
							</Show>
							Delete
						</button>
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}
