import { Dialog } from "@base-ui/react/dialog";
import { ImagePlus, Loader2, Music2, Trash2, X } from "lucide-react";
import { type ChangeEvent, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { reconcilePinnedPlaylists } from "@/lib/stores/pinned";
import { patchCachedPlaylistMetadata } from "@/lib/stores/playlist-cache";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn, hiResThumb } from "@/lib/utils/utils";
import { fetchPlaylistEditMeta } from "@/lib/youtube/playlist-data";
import {
	type PlaylistEdit,
	type PlaylistPrivacy,
	patchLibraryPlaylist,
	removePlaylistThumbnail,
	setPlaylistThumbnail,
	updatePlaylist,
} from "@/lib/youtube/youtube-client";

const MAX_COVER_BYTES = 2 * 1024 * 1024;

const PRIVACY_OPTIONS: Array<{
	value: PlaylistPrivacy;
	label: string;
	hint: string;
}> = [
	{ value: "PUBLIC", label: "Public", hint: "Anyone can find and play it." },
	{ value: "UNLISTED", label: "Unlisted", hint: "Only people with the link." },
	{ value: "PRIVATE", label: "Private", hint: "Only you can see it." },
];

export interface PlaylistEditResult {
	title: string;
	thumbnail: string | null;
}

export function EditPlaylistDialog({
	playlistId,
	currentTitle,
	currentThumbnail,
	open,
	onOpenChange,
	onSaved,
}: {
	playlistId: string | null;
	currentTitle: string;
	currentThumbnail: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved?: (result: PlaylistEditResult) => void;
}) {
	const [status, setStatus] = useState<"loading" | "ready" | "forbidden">(
		"loading",
	);
	const [initial, setInitial] = useState<{
		title: string;
		description: string;
		privacy: PlaylistPrivacy;
	} | null>(null);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [privacy, setPrivacy] = useState<PlaylistPrivacy>("PRIVATE");
	const [coverFile, setCoverFile] = useState<File | null>(null);
	const [coverPreview, setCoverPreview] = useState<string | null>(null);
	const [removeCover, setRemoveCover] = useState(false);
	const [saving, setSaving] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open || !playlistId) return;
		let cancelled = false;
		setStatus("loading");
		setSaving(false);
		setCoverFile(null);
		setRemoveCover(false);
		setCoverPreview((previous) => {
			if (previous) URL.revokeObjectURL(previous);
			return null;
		});
		fetchPlaylistEditMeta(playlistId)
			.then((meta) => {
				if (cancelled) return;
				if (!meta?.editable) {
					setStatus("forbidden");
					return;
				}
				setTitle(meta.title);
				setDescription(meta.description);
				setPrivacy(meta.privacy ?? "PRIVATE");
				setInitial({
					title: meta.title,
					description: meta.description,
					privacy: meta.privacy ?? "PRIVATE",
				});
				setStatus("ready");
			})
			.catch((error) => {
				console.error("[YuMusic] load playlist edit form failed:", error);
				if (!cancelled) setStatus("forbidden");
			});
		return () => {
			cancelled = true;
		};
	}, [open, playlistId]);

	const pickCover = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			showToast("Pick an image file");
			return;
		}
		if (file.size > MAX_COVER_BYTES) {
			showToast("Image is too large (max 2 MB)");
			return;
		}
		setCoverFile(file);
		setRemoveCover(false);
		setCoverPreview((previous) => {
			if (previous) URL.revokeObjectURL(previous);
			return URL.createObjectURL(file);
		});
	};

	const toggleRemoveCover = () => {
		setCoverFile(null);
		setCoverPreview((previous) => {
			if (previous) URL.revokeObjectURL(previous);
			return null;
		});
		setRemoveCover((value) => !value);
	};

	const save = async () => {
		if (!playlistId || saving || status !== "ready") return;
		const name = title.trim();
		if (!name) {
			showToast("Playlist name can't be empty");
			return;
		}
		setSaving(true);
		try {
			const changes: PlaylistEdit = {};
			if (initial) {
				if (name !== initial.title) changes.title = name;
				if (description !== initial.description) {
					changes.description = description;
				}
				if (privacy !== initial.privacy) changes.privacy = privacy;
			}
			await updatePlaylist(playlistId, changes);
			const coverChanged = !!coverFile || removeCover;
			let coverUrl: string | null = null;
			if (coverFile) {
				const bytes = new Uint8Array(await coverFile.arrayBuffer());
				coverUrl = await setPlaylistThumbnail(
					playlistId,
					bytes,
					coverFile.type || "image/jpeg",
				);
			} else if (removeCover) {
				coverUrl = await removePlaylistThumbnail(playlistId);
			}
			// Prefer the cover echoed by the edit; only a follow-up browse can
			// still serve the old image for a while after the change.
			const thumbnail = coverUrl
				? hiResThumb(coverUrl, 1080)
				: coverChanged
					? ((await fetchPlaylistEditMeta(playlistId))?.thumbnail ??
						currentThumbnail)
					: currentThumbnail;
			const result = { title: name, thumbnail };
			patchLibraryPlaylist(playlistId, result);
			patchCachedPlaylistMetadata(playlistId, result);
			reconcilePinnedPlaylists([{ id: playlistId, ...result }]);
			showToast("Playlist updated");
			onSaved?.({ title: name, thumbnail });
			onOpenChange(false);
		} catch (error) {
			console.error("[YuMusic] edit playlist failed:", error);
			showToast("Could not update playlist");
		} finally {
			setSaving(false);
		}
	};

	const hasCover = !!coverPreview || (!removeCover && !!currentThumbnail);
	const coverSrc =
		coverPreview ??
		(!removeCover && currentThumbnail
			? proxiedImageUrl(currentThumbnail)
			: null);

	return (
		<Dialog.Root onOpenChange={onOpenChange} open={open}>
			<Dialog.Portal>
				<Dialog.Backdrop className="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
				<Dialog.Popup className="fixed top-1/2 left-1/2 z-100 flex max-h-[min(38rem,85vh)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
					<div className="flex items-start justify-between gap-4 border-b border-foreground/8 p-4">
						<div className="min-w-0">
							<Dialog.Title className="text-sm font-semibold">
								Edit playlist
							</Dialog.Title>
							<p className="mt-0.5 truncate text-xs text-muted-foreground">
								{currentTitle}
							</p>
						</div>
						<Dialog.Close
							aria-label="Close"
							className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						>
							<X className="size-4" />
						</Dialog.Close>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto">
						{status === "loading" && (
							<p className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
								<Loader2 className="size-3.5 animate-spin" />
								Loading playlist…
							</p>
						)}
						{status === "forbidden" && (
							<p className="px-6 py-16 text-center text-sm text-muted-foreground">
								You can only edit playlists you own.
							</p>
						)}
						{status === "ready" && (
							<div className="space-y-4 p-4">
								<div className="flex items-start gap-4">
									<div className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-foreground/10 bg-card">
										{coverSrc ? (
											<img
												alt=""
												className="size-full object-cover"
												src={coverSrc}
											/>
										) : (
											<Music2 className="size-8 text-muted-foreground" />
										)}
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap gap-2">
											<button
												className="flex items-center gap-2 rounded-lg border border-foreground/12 px-3 py-1.5 text-xs font-medium transition-colors duration-150 hover:border-primary/40 hover:text-primary"
												onClick={() => fileInputRef.current?.click()}
												type="button"
											>
												<ImagePlus className="size-3.5" />
												Change cover
											</button>
											{hasCover && (
												<button
													className={cn(
														"flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-150",
														removeCover
															? "border-primary/40 text-primary"
															: "border-foreground/12 hover:border-destructive/40 hover:text-destructive",
													)}
													onClick={toggleRemoveCover}
													type="button"
												>
													<Trash2 className="size-3.5" />
													{removeCover ? "Undo" : "Remove"}
												</button>
											)}
										</div>
										<p className="mt-2 text-[11px] text-muted-foreground">
											PNG, JPEG or WebP, up to 2 MB.
										</p>
									</div>
									<input
										accept="image/png,image/jpeg,image/webp"
										className="hidden"
										onChange={pickCover}
										ref={fileInputRef}
										type="file"
									/>
								</div>

								<div>
									<label
										className="text-xs font-medium text-muted-foreground"
										htmlFor="playlist-edit-name"
									>
										Name
									</label>
									<Input
										className="mt-1.5 h-9"
										id="playlist-edit-name"
										maxLength={150}
										onChange={(event) => setTitle(event.target.value)}
										value={title}
									/>
								</div>

								<div>
									<label
										className="text-xs font-medium text-muted-foreground"
										htmlFor="playlist-edit-description"
									>
										Description
									</label>
									<textarea
										className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
										id="playlist-edit-description"
										maxLength={5000}
										onChange={(event) => setDescription(event.target.value)}
										placeholder="Add a description"
										value={description}
									/>
								</div>

								<div>
									<span className="text-xs font-medium text-muted-foreground">
										Visibility
									</span>
									<div className="mt-1.5 grid grid-cols-3 gap-1.5">
										{PRIVACY_OPTIONS.map((option) => (
											<button
												className={cn(
													"rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150",
													privacy === option.value
														? "border-primary/50 bg-primary/10 text-primary"
														: "border-foreground/12 text-muted-foreground hover:border-primary/30 hover:text-foreground",
												)}
												key={option.value}
												onClick={() => setPrivacy(option.value)}
												type="button"
											>
												{option.label}
											</button>
										))}
									</div>
									<p className="mt-1.5 text-[11px] text-muted-foreground">
										{
											PRIVACY_OPTIONS.find((option) => option.value === privacy)
												?.hint
										}
									</p>
								</div>
							</div>
						)}
					</div>

					<footer className="flex justify-end gap-2 border-t border-foreground/8 p-4">
						<Dialog.Close className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
							Cancel
						</Dialog.Close>
						{status === "ready" && (
							<button
								className="flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
								disabled={saving || !title.trim()}
								onClick={() => void save()}
								type="button"
							>
								{saving && <Loader2 className="size-3.5 animate-spin" />}
								Save
							</button>
						)}
					</footer>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
