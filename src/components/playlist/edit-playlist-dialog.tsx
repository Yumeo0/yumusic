import { Dialog } from "@kobalte/core/dialog";
import { ImagePlus, Loader2, Music2, Trash2, X } from "@lucide/solid";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Input } from "@/components/ui/input";
import { showToast } from "@/lib/stores/toast";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn, hiResThumb } from "@/lib/utils/utils";
import { fetchPlaylistEditMeta } from "@/lib/youtube/playlist-data";
import {
	type PlaylistEdit,
	type PlaylistPrivacy,
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

export function EditPlaylistDialog(props: {
	playlistId: string | null;
	currentTitle: string;
	currentThumbnail: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSaved?: (result: PlaylistEditResult) => void;
}) {
	const [status, setStatus] = createSignal<"loading" | "ready" | "forbidden">(
		"loading",
	);
	const [initial, setInitial] = createSignal<{
		title: string;
		description: string;
		privacy: PlaylistPrivacy;
	} | null>(null);
	const [title, setTitle] = createSignal("");
	const [description, setDescription] = createSignal("");
	const [privacy, setPrivacy] = createSignal<PlaylistPrivacy>("PRIVATE");
	const [coverFile, setCoverFile] = createSignal<File | null>(null);
	const [coverPreview, setCoverPreview] = createSignal<string | null>(null);
	const [removeCover, setRemoveCover] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	let fileInput!: HTMLInputElement;

	createEffect(
		() => ({ open: props.open, playlistId: props.playlistId }),
		({ open, playlistId }) => {
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
		},
	);

	const pickCover = (event: Event) => {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
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
		const playlistId = props.playlistId;
		if (!playlistId || saving() || status() !== "ready") return;
		const name = title().trim();
		if (!name) {
			showToast("Playlist name can't be empty");
			return;
		}
		setSaving(true);
		try {
			const changes: PlaylistEdit = {};
			const baseline = initial();
			if (baseline) {
				if (name !== baseline.title) changes.title = name;
				if (description() !== baseline.description) {
					changes.description = description();
				}
				if (privacy() !== baseline.privacy) changes.privacy = privacy();
			}
			await updatePlaylist(playlistId, changes);
			const cover = coverFile();
			const coverChanged = !!cover || removeCover();
			let coverUrl: string | null = null;
			if (cover) {
				const bytes = new Uint8Array(await cover.arrayBuffer());
				coverUrl = await setPlaylistThumbnail(
					playlistId,
					bytes,
					cover.type || "image/jpeg",
				);
			} else if (removeCover()) {
				coverUrl = await removePlaylistThumbnail(playlistId);
			}
			// Prefer the cover echoed by the edit; only a follow-up browse can
			// still serve the old image for a while after the change.
			const thumbnail = coverUrl
				? hiResThumb(coverUrl, 1080)
				: coverChanged
					? ((await fetchPlaylistEditMeta(playlistId))?.thumbnail ??
						props.currentThumbnail)
					: props.currentThumbnail;
			showToast("Playlist updated");
			props.onSaved?.({ title: name, thumbnail });
			props.onOpenChange(false);
		} catch (error) {
			console.error("[YuMusic] edit playlist failed:", error);
			showToast("Could not update playlist");
		} finally {
			setSaving(false);
		}
	};

	const hasCover = () =>
		!!coverPreview() || (!removeCover() && !!props.currentThumbnail);
	const coverSrc = () =>
		coverPreview() ??
		(!removeCover() && props.currentThumbnail
			? proxiedImageUrl(props.currentThumbnail)
			: null);

	return (
		<Dialog onOpenChange={props.onOpenChange} open={props.open}>
			<Dialog.Portal>
				<Dialog.Overlay class="fixed inset-0 z-100 bg-black/50 backdrop-blur-xs transition-opacity duration-150 data-[closed]:opacity-0" />
				<Dialog.Content class="fixed top-1/2 left-1/2 z-100 flex max-h-[min(38rem,85vh)] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl outline-none transition-[transform,opacity] duration-150 data-[closed]:scale-95 data-[closed]:opacity-0">
					<div class="flex items-start justify-between gap-4 border-b border-foreground/8 p-4">
						<div class="min-w-0">
							<Dialog.Title class="text-sm font-semibold">
								Edit playlist
							</Dialog.Title>
							<p class="mt-0.5 truncate text-xs text-muted-foreground">
								{props.currentTitle}
							</p>
						</div>
						<Dialog.CloseButton
							aria-label="Close"
							class="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
						>
							<X class="size-4" />
						</Dialog.CloseButton>
					</div>

					<div class="min-h-0 flex-1 overflow-y-auto">
						<Show when={status() === "loading"}>
							<p class="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
								<Loader2 class="size-3.5 animate-spin" />
								Loading playlist…
							</p>
						</Show>
						<Show when={status() === "forbidden"}>
							<p class="px-6 py-16 text-center text-sm text-muted-foreground">
								You can only edit playlists you own.
							</p>
						</Show>
						<Show when={status() === "ready"}>
							<div class="space-y-4 p-4">
								<div class="flex items-start gap-4">
									<div class="grid size-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-foreground/10 bg-card">
										<Show
											fallback={<Music2 class="size-8 text-muted-foreground" />}
											when={coverSrc()}
										>
											{(src) => (
												<img
													alt=""
													class="size-full object-cover"
													src={src()}
												/>
											)}
										</Show>
									</div>
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap gap-2">
											<button
												class="flex items-center gap-2 rounded-lg border border-foreground/12 px-3 py-1.5 text-xs font-medium transition-colors duration-150 hover:border-primary/40 hover:text-primary"
												onClick={() => fileInput.click()}
												type="button"
											>
												<ImagePlus class="size-3.5" />
												Change cover
											</button>
											<Show when={hasCover()}>
												<button
													class={cn(
														"flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors duration-150",
														removeCover()
															? "border-primary/40 text-primary"
															: "border-foreground/12 hover:border-destructive/40 hover:text-destructive",
													)}
													onClick={toggleRemoveCover}
													type="button"
												>
													<Trash2 class="size-3.5" />
													{removeCover() ? "Undo" : "Remove"}
												</button>
											</Show>
										</div>
										<p class="mt-2 text-[11px] text-muted-foreground">
											PNG, JPEG or WebP, up to 2 MB.
										</p>
									</div>
									<input
										accept="image/png,image/jpeg,image/webp"
										class="hidden"
										onChange={pickCover}
										ref={fileInput}
										type="file"
									/>
								</div>

								<div>
									<label
										class="text-xs font-medium text-muted-foreground"
										for="playlist-edit-name"
									>
										Name
									</label>
									<Input
										class="mt-1.5 h-9"
										id="playlist-edit-name"
										maxlength={150}
										onInput={(event) => {
											setTitle(event.target.value);
										}}
										value={title()}
									/>
								</div>

								<div>
									<label
										class="text-xs font-medium text-muted-foreground"
										for="playlist-edit-description"
									>
										Description
									</label>
									<textarea
										class="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring"
										id="playlist-edit-description"
										maxlength={5000}
										onInput={(event) => {
											setDescription(event.target.value);
										}}
										placeholder="Add a description"
										value={description()}
									/>
								</div>

								<div>
									<span class="text-xs font-medium text-muted-foreground">
										Visibility
									</span>
									<div class="mt-1.5 grid grid-cols-3 gap-1.5">
										<For each={PRIVACY_OPTIONS}>
											{(option) => (
												<button
													class={cn(
														"rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150",
														privacy() === option.value
															? "border-primary/50 bg-primary/10 text-primary"
															: "border-foreground/12 text-muted-foreground hover:border-primary/30 hover:text-foreground",
													)}
													onClick={() => setPrivacy(option.value)}
													type="button"
												>
													{option.label}
												</button>
											)}
										</For>
									</div>
									<p class="mt-1.5 text-[11px] text-muted-foreground">
										{
											PRIVACY_OPTIONS.find(
												(option) => option.value === privacy(),
											)?.hint
										}
									</p>
								</div>
							</div>
						</Show>
					</div>

					<footer class="flex justify-end gap-2 border-t border-foreground/8 p-4">
						<Dialog.CloseButton class="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground">
							Cancel
						</Dialog.CloseButton>
						<Show when={status() === "ready"}>
							<button
								class="flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-50"
								disabled={saving() || !title().trim()}
								onClick={() => void save()}
								type="button"
							>
								<Show when={saving()}>
									<Loader2 class="size-3.5 animate-spin" />
								</Show>
								Save
							</button>
						</Show>
					</footer>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog>
	);
}
