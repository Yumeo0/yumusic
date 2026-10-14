import {
	ChevronDown,
	ChevronUp,
	Eye,
	EyeOff,
	GripVertical,
	HardDrive,
	LogIn,
	LogOut,
	Trash2,
} from "@lucide/solid";
import type { JSX } from "@solidjs/web";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createEffect, createSignal, For, Show } from "solid-js";
import { UpdatesSection } from "@/components/app/updates";
import { StorageManagerDialog } from "@/components/settings/storage-manager-dialog";
import { Input } from "@/components/ui/input";
import { useDownloads } from "@/lib/downloads/downloads";
import {
	LYRICS_KIND_LABELS,
	LYRICS_PROVIDERS,
	type LyricsProviderId,
} from "@/lib/lyrics/lyrics-providers";
import { validateListenbrainzToken } from "@/lib/services/listenbrainz";
import { updaterSupported } from "@/lib/services/updater";
import {
	CROSSFADE_MAX_SECONDS,
	CROSSFADE_MIN_SECONDS,
	clampCrossfadeSeconds,
	useSettings,
} from "@/lib/stores/settings";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn, formatBytes } from "@/lib/utils/utils";

const PROVIDER_LABEL = new Map(LYRICS_PROVIDERS.map((p) => [p.id, p.label]));
const PROVIDER_KINDS = new Map(LYRICS_PROVIDERS.map((p) => [p.id, p.kinds]));
const LISTENBRAINZ_TOKEN_URL = "https://listenbrainz.org/settings/#auth-token";

interface SettingsPageProps {
	isLoggedIn: boolean;
	userProfile: { name?: string; photo?: string } | null;
	handleLogin: () => void;
	handleLogout: () => void;
}

/** Switch row control shared by every boolean setting. */
function Toggle(props: {
	label: string;
	pressed: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			aria-label={props.label}
			aria-pressed={props.pressed ? "true" : "false"}
			class={cn(
				"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
				props.pressed ? "bg-primary" : "bg-foreground/15",
			)}
			onClick={props.onToggle}
			type="button"
		>
			<span
				class={cn(
					"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
					props.pressed && "translate-x-5",
				)}
			/>
		</button>
	);
}

export default function SettingsPage(props: SettingsPageProps) {
	const [settings, update] = useSettings();
	const downloads = useDownloads();
	const [cleared, setCleared] = createSignal(false);
	const [storageOpen, setStorageOpen] = createSignal(false);
	const [showToken, setShowToken] = createSignal(false);
	const [dragProvider, setDragProvider] = createSignal<LyricsProviderId | null>(
		null,
	);
	/** Provider order previewed live while dragging; committed on drop. */
	const [dragOrder, setDragOrder] = createSignal<LyricsProviderId[] | null>(
		null,
	);
	const [tokenState, setTokenState] = createSignal<{
		valid: boolean;
		user?: string;
	} | null>(null);

	const reorderProviders = (next: LyricsProviderId[]) =>
		update({ lyricsProviderOrder: next });

	const moveProvider = (id: LyricsProviderId, direction: -1 | 1) => {
		const order = [...settings.lyricsProviderOrder];
		const index = order.indexOf(id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= order.length) return;
		[order[index], order[target]] = [order[target], order[index]];
		reorderProviders(order);
	};

	// The order rendered while dragging: other rows move out of the way so the
	// drop position is visible before releasing.
	const providerOrder = () => dragOrder() ?? settings.lyricsProviderOrder;

	const startProviderDrag = (id: LyricsProviderId) => {
		setDragProvider(id);
		setDragOrder([...settings.lyricsProviderOrder]);
	};

	/**
	 * Moves the dragged provider to the hovered row — before or after it
	 * depending on which half of the row the pointer is in.
	 */
	const dragProviderOver = (event: DragEvent, targetId: LyricsProviderId) => {
		event.preventDefault();
		const dragged = dragProvider();
		if (!dragged || dragged === targetId) return;
		const order = dragOrder() ?? settings.lyricsProviderOrder;
		const from = order.indexOf(dragged);
		if (from < 0) return;
		const next = order.filter((providerId) => providerId !== dragged);
		let insertAt = next.indexOf(targetId);
		if (insertAt < 0) return;
		const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
		if (event.clientY > rect.top + rect.height / 2) insertAt += 1;
		if (insertAt === from) return;
		next.splice(insertAt, 0, dragged);
		setDragOrder(next);
	};

	const commitProviderDrag = () => {
		const order = dragOrder();
		if (order) reorderProviders(order);
		setDragProvider(null);
		setDragOrder(null);
	};

	const cancelProviderDrag = () => {
		setDragProvider(null);
		setDragOrder(null);
	};

	// Verify the ListenBrainz token whenever it changes (debounced).
	createEffect(
		() => ({
			enabled: settings.listenbrainz,
			raw: settings.listenbrainzToken,
		}),
		({ enabled, raw }) => {
			const token = raw.trim();
			if (!enabled || token.length < 8) {
				setTokenState(null);
				return;
			}
			const timer = window.setTimeout(() => {
				validateListenbrainzToken(token)
					.then(setTokenState)
					.catch(() => setTokenState({ valid: false }));
			}, 600);
			return () => window.clearTimeout(timer);
		},
	);

	const clearCaches = () => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith("yumusic:") && !key.startsWith("yumusic:settings")) {
				localStorage.removeItem(key);
			}
		}
		setCleared(true);
	};

	return (
		<div class="mx-auto w-full max-w-3xl px-6 pt-6 sm:px-10 sm:pt-10">
			<p class="mb-2 font-mono text-[11px] font-medium tracking-[0.24em] text-primary">
				APP
			</p>
			<h1 class="text-3xl font-bold tracking-tight">Settings</h1>

			{/* Account */}
			<section class="mt-8">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Account</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<Show
						fallback={
							<div class="flex items-center justify-between gap-6 p-4">
								<div class="min-w-0">
									<p class="text-sm font-medium">Not logged in</p>
									<p class="mt-0.5 text-xs text-muted-foreground">
										Log in to see your playlists, mixes and recommendations.
									</p>
								</div>
								<button
									class="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95"
									onClick={props.handleLogin}
									type="button"
								>
									<LogIn class="size-4" />
									Log In
								</button>
							</div>
						}
						when={props.isLoggedIn}
					>
						<div class="flex items-center justify-between gap-6 p-4">
							<div class="flex min-w-0 items-center gap-3">
								<Show
									fallback={
										<div class="grid size-9 shrink-0 place-items-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
											{props.userProfile?.name?.[0]?.toUpperCase() || "U"}
										</div>
									}
									when={props.userProfile?.photo}
								>
									{(photo) => (
										<img
											alt={props.userProfile?.name}
											class="size-9 shrink-0 rounded-full object-cover"
											src={proxiedImageUrl(photo())}
										/>
									)}
								</Show>
								<p class="truncate text-sm font-medium">
									{props.userProfile?.name || "User"}
								</p>
							</div>
							<button
								class="flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 active:scale-95"
								onClick={props.handleLogout}
								type="button"
							>
								<LogOut class="size-4" />
								Log Out
							</button>
						</div>
					</Show>
				</div>
			</section>

			{/* Home feed */}
			<section class="mt-8">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Home feed</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Hide "Today's biggest hits"</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Remove the "Today's biggest hits" row from the home page.
							</p>
						</div>
						<Toggle
							label="Toggle Today's biggest hits row"
							onToggle={() =>
								update({
									hideTodaysBiggestHits: !settings.hideTodaysBiggestHits,
								})
							}
							pressed={settings.hideTodaysBiggestHits}
						/>
					</div>
				</div>
			</section>

			{/* Lyrics */}
			<section class="mt-8">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Lyrics</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Romanize lyrics</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Show a latin reading under each line for Japanese, Chinese and
								Korean lyrics, with extra spacing for readability.
							</p>
						</div>
						<Toggle
							label="Toggle romanized lyrics"
							onToggle={() =>
								update({ romanizeLyrics: !settings.romanizeLyrics })
							}
							pressed={settings.romanizeLyrics}
						/>
					</div>

					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Prefer synced lyrics</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Word-synced lyrics are preferred over line-synced ones. If the
								top provider only offers plain lyrics, use the highest-priority
								provider that has time-aligned lyrics instead.
							</p>
						</div>
						<Toggle
							label="Toggle prefer synced lyrics"
							onToggle={() =>
								update({ preferSyncedLyrics: !settings.preferSyncedLyrics })
							}
							pressed={settings.preferSyncedLyrics}
						/>
					</div>

					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Loose lyrics matching</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								When LRCLIB has nothing for the exact title and artist, also
								search by title alone and accept a length match. More forgiving,
								but can return the wrong version.
							</p>
						</div>
						<Toggle
							label="Toggle loose lyrics matching"
							onToggle={() =>
								update({ lrclibLooseMatch: !settings.lrclibLooseMatch })
							}
							pressed={settings.lrclibLooseMatch}
						/>
					</div>

					<div class="p-4">
						<p class="text-sm font-medium">Preferred providers</p>
						<p class="mt-0.5 text-xs text-muted-foreground">
							Drag to reorder, or use the arrows. The highest available provider
							is used first; badges show the lyric detail each one can return.
						</p>
						<ul
							class="mt-3 space-y-1.5"
							onDragOver={(event) => event.preventDefault()}
							onDrop={(event) => {
								event.preventDefault();
								commitProviderDrag();
							}}
						>
							<For each={providerOrder()}>
								{(id, index) => (
									<li
										class={cn(
											"flex items-center gap-2 rounded-lg border border-foreground/8 bg-background/40 px-2.5 py-1.5 transition-opacity",
											dragProvider() === id && "border-primary/30 opacity-40",
										)}
										draggable="true"
										onDragEnd={cancelProviderDrag}
										onDragOver={(event) => dragProviderOver(event, id)}
										onDragStart={() => startProviderDrag(id)}
									>
										<GripVertical class="size-4 shrink-0 cursor-grab text-muted-foreground/50" />
										<span class="flex-1 text-sm font-medium">
											{PROVIDER_LABEL.get(id) ?? id}
										</span>
										<div class="flex shrink-0 items-center gap-1">
											<For each={PROVIDER_KINDS.get(id) ?? []}>
												{(kind) => (
													<span
														class={cn(
															"rounded-full border px-1.5 py-px text-[10px] font-medium",
															kind === "plain"
																? "border-foreground/12 text-muted-foreground"
																: "border-primary/30 text-primary",
														)}
													>
														{LYRICS_KIND_LABELS[kind]}
													</span>
												)}
											</For>
										</div>
										<button
											aria-label={`Move ${PROVIDER_LABEL.get(id) ?? id} up`}
											class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
											disabled={index() === 0}
											onClick={() => moveProvider(id, -1)}
											type="button"
										>
											<ChevronUp class="size-4" />
										</button>
										<button
											aria-label={`Move ${PROVIDER_LABEL.get(id) ?? id} down`}
											class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
											disabled={
												index() === settings.lyricsProviderOrder.length - 1
											}
											onClick={() => moveProvider(id, 1)}
											type="button"
										>
											<ChevronDown class="size-4" />
										</button>
									</li>
								)}
							</For>
						</ul>
					</div>
				</div>
			</section>

			{/* Song titles */}
			<section class="mt-10">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Song titles</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Dual-language titles</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Some tracks pair an original and a translated title or artist
								name, e.g. "本能スピード - Instinctive Speed". Choose which part
								to show.
							</p>
						</div>
						<div class="flex shrink-0 overflow-hidden rounded-full border border-foreground/12">
							<For
								each={
									[
										["both", "Both"],
										["original", "Original"],
										["translation", "Translation"],
									] as const
								}
							>
								{([mode, label]) => (
									<button
										class={cn(
											"h-8 px-3 text-xs font-medium transition-colors duration-200",
											settings.titleMode === mode
												? "bg-primary text-primary-foreground"
												: "text-muted-foreground hover:text-foreground",
										)}
										onClick={() => update({ titleMode: mode })}
										type="button"
									>
										{label}
									</button>
								)}
							</For>
						</div>
					</div>
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Clean up titles</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Strip noise from the end of titles, e.g. "美人局 covered by
								藍月なくる" → "美人局".
							</p>
						</div>
						<Toggle
							label="Toggle title cleanup"
							onToggle={() => update({ cleanTitles: !settings.cleanTitles })}
							pressed={settings.cleanTitles}
						/>
					</div>
				</div>
			</section>

			{/* Playback */}
			<section class="mt-10">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Playback</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Autoplay</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Keep playing similar songs when the queue ends, instead of
								stopping after the last track.
							</p>
						</div>
						<Toggle
							label="Toggle autoplay"
							onToggle={() => update({ autoplay: !settings.autoplay })}
							pressed={settings.autoplay}
						/>
					</div>
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Crossfade</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Blend the end of a song into the start of the next one instead
								of cutting between tracks. Needs an upcoming song from the queue
								or autoplay.
							</p>
						</div>
						<Toggle
							label="Toggle crossfade"
							onToggle={() => update({ crossfade: !settings.crossfade })}
							pressed={settings.crossfade}
						/>
					</div>
					<Show when={settings.crossfade}>
						<div class="p-4">
							<div class="flex items-center justify-between gap-6">
								<label class="text-sm font-medium" for="crossfade-length">
									Crossfade length
								</label>
								<span class="font-mono text-xs text-muted-foreground tabular-nums">
									{settings.crossfadeSeconds}s
								</span>
							</div>
							<input
								class="range-fx mt-3 w-full"
								id="crossfade-length"
								max={CROSSFADE_MAX_SECONDS}
								min={CROSSFADE_MIN_SECONDS}
								onInput={(event) =>
									update({
										crossfadeSeconds: clampCrossfadeSeconds(
											Number((event.target as HTMLInputElement).value),
										),
									})
								}
								step={1}
								style={
									{
										"--vol":
											(settings.crossfadeSeconds - CROSSFADE_MIN_SECONDS) /
											(CROSSFADE_MAX_SECONDS - CROSSFADE_MIN_SECONDS),
									} as JSX.CSSProperties
								}
								type="range"
								value={settings.crossfadeSeconds}
							/>
							<p class="mt-2 text-xs text-muted-foreground">
								Seconds of overlap. The next song starts this much before the
								current one ends.
							</p>
						</div>
					</Show>
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Watch history</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Report played songs to your YouTube watch history, including the
								watched progress — the same pings the web player sends.
							</p>
						</div>
						<Toggle
							label="Toggle watch history reporting"
							onToggle={() => update({ watchHistory: !settings.watchHistory })}
							pressed={settings.watchHistory}
						/>
					</div>
				</div>
			</section>

			{/* ListenBrainz */}
			<section class="mt-10">
				<h2 class="mb-3 text-sm font-semibold text-foreground">ListenBrainz</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Scrobbling</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Send your plays to ListenBrainz. Tracks are matched on
								MusicBrainz and submitted with their recording ID so they land
								in your history correctly.
							</p>
						</div>
						<Toggle
							label="Toggle ListenBrainz scrobbling"
							onToggle={() => update({ listenbrainz: !settings.listenbrainz })}
							pressed={settings.listenbrainz}
						/>
					</div>
					<Show when={settings.listenbrainz}>
						<div class="p-4">
							<label class="text-sm font-medium" for="lb-token">
								User token
							</label>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Copy the token from your{" "}
								<a
									class="text-primary underline underline-offset-2 hover:brightness-110"
									href={LISTENBRAINZ_TOKEN_URL}
									onClick={(event) => {
										event.preventDefault();
										void openUrl(LISTENBRAINZ_TOKEN_URL);
									}}
								>
									ListenBrainz settings
								</a>{" "}
								(it's listed under "User token").
							</p>
							<div class="relative mt-2 max-w-sm">
								<Input
									autocomplete="off"
									class="pr-10 font-mono"
									id="lb-token"
									onInput={(event) => {
										setTokenState(null);
										update({
											listenbrainzToken: event.target.value.trim(),
										});
									}}
									placeholder="Paste your ListenBrainz token"
									type={showToken() ? "text" : "password"}
									value={settings.listenbrainzToken}
								/>
								<button
									aria-label={showToken() ? "Hide token" : "Show token"}
									class="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
									onClick={() => setShowToken((value) => !value)}
									title={showToken() ? "Hide token" : "Show token"}
									type="button"
								>
									<Show fallback={<Eye class="size-4" />} when={showToken()}>
										<EyeOff class="size-4" />
									</Show>
								</button>
							</div>
							<p
								class={cn(
									"mt-1.5 text-xs",
									tokenState()?.valid
										? "text-primary"
										: tokenState()
											? "text-destructive"
											: "text-muted-foreground/70",
								)}
							>
								{tokenState() === null
									? "Token not verified yet."
									: tokenState()?.valid
										? `Connected as ${tokenState()?.user ?? "unknown user"}.`
										: "Token invalid — check that you copied it correctly."}
							</p>
						</div>
					</Show>
				</div>
			</section>

			{/* Discord */}
			<section class="mt-10">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Discord</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Rich presence</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Show the song you're listening to on your Discord profile, with
								cover art and links to the song, album and artist. Discord must
								be running for the presence to appear.
							</p>
						</div>
						<Toggle
							label="Toggle Discord rich presence"
							onToggle={() => update({ discordRpc: !settings.discordRpc })}
							pressed={settings.discordRpc}
						/>
					</div>
				</div>
			</section>

			{/* Storage */}
			<section class="mt-10">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Storage</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Synced caches</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Clear the locally stored playlists and artist data. They will be
								fetched again on next visit.
							</p>
						</div>
						<button
							class={cn(
								"flex h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-200",
								cleared()
									? "border-primary/40 text-primary"
									: "border-foreground/12 text-muted-foreground hover:border-destructive/40 hover:text-destructive",
							)}
							onClick={clearCaches}
							type="button"
						>
							<Trash2 class="size-4" />
							{cleared() ? "Cleared" : "Clear"}
						</button>
					</div>
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Downloads</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Songs saved on this device for offline playback. Open the
								storage manager to remove them.
							</p>
						</div>
						<button
							class="flex h-9 shrink-0 items-center gap-2 rounded-full border border-foreground/12 px-4 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:border-primary/40 hover:text-foreground"
							onClick={() => setStorageOpen(true)}
							type="button"
						>
							<HardDrive class="size-4" />
							Manage
							{downloads.totalBytes > 0
								? ` · ${formatBytes(downloads.totalBytes)}`
								: ""}
						</button>
					</div>
				</div>
			</section>

			{/* Updates (desktop only — the plugin doesn't exist on mobile) */}
			<Show when={updaterSupported()}>
				<UpdatesSection />
			</Show>

			{/* Developer */}
			<section class="mt-10">
				<h2 class="mb-3 text-sm font-semibold text-foreground">Developer</h2>
				<div class="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div class="flex items-center justify-between gap-6 p-4">
						<div class="min-w-0">
							<p class="text-sm font-medium">Developer mode</p>
							<p class="mt-0.5 text-xs text-muted-foreground">
								Add extra copy actions to song context menus (original title,
								video ID, thumbnail URL, raw song data).
							</p>
						</div>
						<Toggle
							label="Toggle developer mode"
							onToggle={() =>
								update({ developerMode: !settings.developerMode })
							}
							pressed={settings.developerMode}
						/>
					</div>
				</div>
			</section>

			<StorageManagerDialog
				onOpenChange={setStorageOpen}
				open={storageOpen()}
			/>
		</div>
	);
}
