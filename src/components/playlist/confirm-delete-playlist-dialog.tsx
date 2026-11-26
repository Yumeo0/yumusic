import { Dialog } from "@base-ui/react/dialog";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { showToast } from "@/lib/stores/toast";
import { deleteLibraryPlaylist } from "@/lib/youtube/playlist-mutations";

export function ConfirmDeletePlaylistDialog({
	playlistId,
	playlistTitle,
	open,
	onOpenChange,
}: {
	playlistId: string;
	playlistTitle: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const [busy, setBusy] = useState(false);

	const confirmDelete = async () => {
		if (busy) return;
		setBusy(true);
		try {
			await deleteLibraryPlaylist(playlistId);
			onOpenChange(false);
			showToast("Playlist deleted");
		} catch (error) {
			console.error("[YuMusic] delete playlist failed:", error);
			showToast("Could not delete playlist");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog.Root onOpenChange={onOpenChange} open={open}>
			<Dialog.Portal>
				<Dialog.Backdrop className="ui-backdrop fixed inset-0 z-100 bg-black/50 backdrop-blur-xs" />
				<Dialog.Popup className="ui-popup fixed top-1/2 left-1/2 z-100 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-foreground/10 bg-popover p-5 text-popover-foreground shadow-2xl outline-none">
					<Dialog.Title className="text-base font-semibold">
						Delete playlist?
					</Dialog.Title>
					<Dialog.Description className="mt-1.5 text-sm text-muted-foreground">
						"{playlistTitle}" will be permanently deleted from your YouTube
						Music library.
					</Dialog.Description>
					<div className="mt-5 flex justify-end gap-2">
						<Dialog.Close className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
							Cancel
						</Dialog.Close>
						<button
							className="flex items-center gap-2 rounded-lg bg-destructive px-3.5 py-2 text-sm font-semibold text-destructive-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
							disabled={busy}
							onClick={() => void confirmDelete()}
							type="button"
						>
							{busy && <Loader2 className="size-3.5 animate-spin" />}
							Delete
						</button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
