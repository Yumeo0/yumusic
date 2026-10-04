import { openUrl } from "@tauri-apps/plugin-opener";
import {
	ChevronDown,
	ChevronUp,
	Eye,
	EyeOff,
	GripVertical,
	LogIn,
	LogOut,
	Trash2,
} from "lucide-react";
import { type DragEvent, useEffect, useState } from "react";
import { UpdatesSection } from "@/components/app/updates";
import { Input } from "@/components/ui/input";
import {
	LYRICS_KIND_LABELS,
	LYRICS_PROVIDERS,
	type LyricsProviderId,
} from "@/lib/lyrics/lyrics-providers";
import { validateListenbrainzToken } from "@/lib/services/listenbrainz";
import { updaterSupported } from "@/lib/services/updater";
import { useSettings } from "@/lib/stores/settings";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { cn } from "@/lib/utils/utils";

const PROVIDER_LABEL = new Map(LYRICS_PROVIDERS.map((p) => [p.id, p.label]));
const PROVIDER_KINDS = new Map(LYRICS_PROVIDERS.map((p) => [p.id, p.kinds]));
const LISTENBRAINZ_TOKEN_URL = "https://listenbrainz.org/settings/#auth-token";

interface SettingsPageProps {
	isLoggedIn: boolean;
	userProfile: { name?: string; photo?: string } | null;
	handleLogin: () => void;
	handleLogout: () => void;
}

export default function SettingsPage({
	handleLogin,
	handleLogout,
	isLoggedIn,
	userProfile,
}: SettingsPageProps) {
	const [settings, update] = useSettings();
	const [cleared, setCleared] = useState(false);
	const [showToken, setShowToken] = useState(false);
	const [dragProvider, setDragProvider] = useState<LyricsProviderId | null>(
		null,
	);
	/** Provider order previewed live while dragging; committed on drop. */
	const [dragOrder, setDragOrder] = useState<LyricsProviderId[] | null>(null);
	const [tokenState, setTokenState] = useState<{
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
	const providerOrder = dragOrder ?? settings.lyricsProviderOrder;

	const startProviderDrag = (id: LyricsProviderId) => {
		setDragProvider(id);
		setDragOrder([...settings.lyricsProviderOrder]);
	};

	/**
	 * Moves the dragged provider to the hovered row — before or after it
	 * depending on which half of the row the pointer is in.
	 */
	const dragProviderOver = (
		event: DragEvent<HTMLLIElement>,
		targetId: LyricsProviderId,
	) => {
		event.preventDefault();
		if (!dragProvider || dragProvider === targetId) return;
		const order = dragOrder ?? settings.lyricsProviderOrder;
		const from = order.indexOf(dragProvider);
		if (from < 0) return;
		const next = order.filter((providerId) => providerId !== dragProvider);
		let insertAt = next.indexOf(targetId);
		if (insertAt < 0) return;
		const rect = event.currentTarget.getBoundingClientRect();
		if (event.clientY > rect.top + rect.height / 2) insertAt += 1;
		if (insertAt === from) return;
		next.splice(insertAt, 0, dragProvider);
		setDragOrder(next);
	};

	const commitProviderDrag = () => {
		if (dragOrder) reorderProviders(dragOrder);
		setDragProvider(null);
		setDragOrder(null);
	};

	const cancelProviderDrag = () => {
		setDragProvider(null);
		setDragOrder(null);
	};

	// Verify the ListenBrainz token whenever it changes (debounced).
	useEffect(() => {
		const token = settings.listenbrainzToken.trim();
		if (!settings.listenbrainz || token.length < 8) {
			setTokenState(null);
			return;
		}
		const timer = window.setTimeout(() => {
			validateListenbrainzToken(token)
				.then(setTokenState)
				.catch(() => setTokenState({ valid: false }));
		}, 600);
		return () => window.clearTimeout(timer);
	}, [settings.listenbrainzToken, settings.listenbrainz]);

	const clearCaches = () => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith("yumusic:") && !key.startsWith("yumusic:settings")) {
				localStorage.removeItem(key);
			}
		}
		setCleared(true);
	};

	return (
		<div className="mx-auto w-full max-w-3xl px-6 pt-6 sm:px-10 sm:pt-10">
			<p className="mb-2 font-mono text-[11px] font-medium tracking-[0.24em] text-primary">
				APP
			</p>
			<h1 className="text-3xl font-bold tracking-tight">Settings</h1>

			{/* Account */}
			<section className="mt-8">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Account</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					{isLoggedIn ? (
						<div className="flex items-center justify-between gap-6 p-4">
							<div className="flex min-w-0 items-center gap-3">
								{userProfile?.photo ? (
									<img
										alt={userProfile.name}
										className="size-9 shrink-0 rounded-full object-cover"
										src={proxiedImageUrl(userProfile.photo)}
									/>
								) : (
									<div className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/20 text-sm font-semibold text-primary">
										{userProfile?.name?.[0]?.toUpperCase() || "U"}
									</div>
								)}
								<p className="truncate text-sm font-medium">
									{userProfile?.name || "User"}
								</p>
							</div>
							<button
								className="flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-destructive transition-colors duration-150 hover:bg-destructive/10 active:scale-95"
								onClick={handleLogout}
								type="button"
							>
								<LogOut className="size-4" />
								Log Out
							</button>
						</div>
					) : (
						<div className="flex items-center justify-between gap-6 p-4">
							<div className="min-w-0">
								<p className="text-sm font-medium">Not logged in</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									Log in to see your playlists, mixes and recommendations.
								</p>
							</div>
							<button
								className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-all duration-150 hover:brightness-110 active:scale-95"
								onClick={handleLogin}
								type="button"
							>
								<LogIn className="size-4" />
								Log In
							</button>
						</div>
					)}
				</div>
			</section>

			{/* Home feed */}
			<section className="mt-8">
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					Home feed
				</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Hide "Today's biggest hits"</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Remove the "Today's biggest hits" row from the home page.
							</p>
						</div>
						<button
							aria-label="Toggle Today's biggest hits row"
							aria-pressed={settings.hideTodaysBiggestHits}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.hideTodaysBiggestHits
									? "bg-primary"
									: "bg-foreground/15",
							)}
							onClick={() =>
								update({
									hideTodaysBiggestHits: !settings.hideTodaysBiggestHits,
								})
							}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.hideTodaysBiggestHits && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* Lyrics */}
			<section className="mt-8">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Lyrics</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Romanize lyrics</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Show a latin reading under each line for Japanese, Chinese and
								Korean lyrics, with extra spacing for readability.
							</p>
						</div>
						<button
							aria-label="Toggle romanized lyrics"
							aria-pressed={settings.romanizeLyrics}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.romanizeLyrics ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() =>
								update({ romanizeLyrics: !settings.romanizeLyrics })
							}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.romanizeLyrics && "translate-x-5",
								)}
							/>
						</button>
					</div>

					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Prefer synced lyrics</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								If the top provider only offers plain lyrics, use the
								highest-priority provider that has time-aligned lyrics instead.
							</p>
						</div>
						<button
							aria-label="Toggle prefer synced lyrics"
							aria-pressed={settings.preferSyncedLyrics}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.preferSyncedLyrics ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() =>
								update({ preferSyncedLyrics: !settings.preferSyncedLyrics })
							}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.preferSyncedLyrics && "translate-x-5",
								)}
							/>
						</button>
					</div>

					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Loose lyrics matching</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								When LRCLIB has nothing for the exact title and artist, also
								search by title alone and accept a length match. More forgiving,
								but can return the wrong version.
							</p>
						</div>
						<button
							aria-label="Toggle loose lyrics matching"
							aria-pressed={settings.lrclibLooseMatch}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.lrclibLooseMatch ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() =>
								update({ lrclibLooseMatch: !settings.lrclibLooseMatch })
							}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.lrclibLooseMatch && "translate-x-5",
								)}
							/>
						</button>
					</div>

					<div className="p-4">
						<p className="text-sm font-medium">Preferred providers</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Drag to reorder, or use the arrows. The highest available provider
							is used first; badges show the lyric detail each one can return.
						</p>
						<ul
							className="mt-3 space-y-1.5"
							onDragOver={(event) => event.preventDefault()}
							onDrop={(event) => {
								event.preventDefault();
								commitProviderDrag();
							}}
						>
							{providerOrder.map((id, index) => (
								<li
									className={cn(
										"flex items-center gap-2 rounded-lg border border-foreground/8 bg-background/40 px-2.5 py-1.5 transition-opacity",
										dragProvider === id && "border-primary/30 opacity-40",
									)}
									draggable
									key={id}
									onDragEnd={cancelProviderDrag}
									onDragOver={(event) => dragProviderOver(event, id)}
									onDragStart={() => startProviderDrag(id)}
								>
									<GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/50" />
									<span className="flex-1 text-sm font-medium">
										{PROVIDER_LABEL.get(id) ?? id}
									</span>
									<div className="flex shrink-0 items-center gap-1">
										{PROVIDER_KINDS.get(id)?.map((kind) => (
											<span
												className={cn(
													"rounded-full border px-1.5 py-px text-[10px] font-medium",
													kind === "plain"
														? "border-foreground/12 text-muted-foreground"
														: "border-primary/30 text-primary",
												)}
												key={kind}
											>
												{LYRICS_KIND_LABELS[kind]}
											</span>
										))}
									</div>
									<button
										aria-label={`Move ${PROVIDER_LABEL.get(id) ?? id} up`}
										className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
										disabled={index === 0}
										onClick={() => moveProvider(id, -1)}
										type="button"
									>
										<ChevronUp className="size-4" />
									</button>
									<button
										aria-label={`Move ${PROVIDER_LABEL.get(id) ?? id} down`}
										className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
										disabled={index === settings.lyricsProviderOrder.length - 1}
										onClick={() => moveProvider(id, 1)}
										type="button"
									>
										<ChevronDown className="size-4" />
									</button>
								</li>
							))}
						</ul>
					</div>
				</div>
			</section>

			{/* Song titles */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					Song titles
				</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Dual-language titles</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Some tracks pair an original and a translated title or artist
								name, e.g. "本能スピード - Instinctive Speed". Choose which part
								to show.
							</p>
						</div>
						<div className="flex shrink-0 overflow-hidden rounded-full border border-foreground/12">
							{(
								[
									["both", "Both"],
									["original", "Original"],
									["translation", "Translation"],
								] as const
							).map(([mode, label]) => (
								<button
									className={cn(
										"h-8 px-3 text-xs font-medium transition-colors duration-200",
										settings.titleMode === mode
											? "bg-primary text-primary-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
									key={mode}
									onClick={() => update({ titleMode: mode })}
									type="button"
								>
									{label}
								</button>
							))}
						</div>
					</div>
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Clean up titles</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Strip noise from the end of titles, e.g. "美人局 covered by
								藍月なくる" → "美人局".
							</p>
						</div>
						<button
							aria-label="Toggle title cleanup"
							aria-pressed={settings.cleanTitles}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.cleanTitles ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ cleanTitles: !settings.cleanTitles })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.cleanTitles && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* Playback */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Playback</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Autoplay</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Keep playing similar songs when the queue ends, instead of
								stopping after the last track.
							</p>
						</div>
						<button
							aria-label="Toggle autoplay"
							aria-pressed={settings.autoplay}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.autoplay ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ autoplay: !settings.autoplay })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.autoplay && "translate-x-5",
								)}
							/>
						</button>
					</div>
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Watch history</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Report played songs to your YouTube watch history, including the
								watched progress — the same pings the web player sends.
							</p>
						</div>
						<button
							aria-label="Toggle watch history reporting"
							aria-pressed={settings.watchHistory}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.watchHistory ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ watchHistory: !settings.watchHistory })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.watchHistory && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* ListenBrainz */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					ListenBrainz
				</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Scrobbling</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Send your plays to ListenBrainz. Tracks are matched on
								MusicBrainz and submitted with their recording ID so they land
								in your history correctly.
							</p>
						</div>
						<button
							aria-label="Toggle ListenBrainz scrobbling"
							aria-pressed={settings.listenbrainz}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.listenbrainz ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ listenbrainz: !settings.listenbrainz })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.listenbrainz && "translate-x-5",
								)}
							/>
						</button>
					</div>
					{settings.listenbrainz && (
						<div className="p-4">
							<label className="text-sm font-medium" htmlFor="lb-token">
								User token
							</label>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Copy the token from your{" "}
								<a
									className="text-primary underline underline-offset-2 hover:brightness-110"
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
							<div className="relative mt-2 max-w-sm">
								<Input
									autoComplete="off"
									className="pr-10 font-mono"
									id="lb-token"
									onChange={(event) => {
										setTokenState(null);
										update({ listenbrainzToken: event.target.value.trim() });
									}}
									placeholder="Paste your ListenBrainz token"
									type={showToken ? "text" : "password"}
									value={settings.listenbrainzToken}
								/>
								<button
									aria-label={showToken ? "Hide token" : "Show token"}
									className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors duration-150 hover:bg-foreground/8 hover:text-foreground"
									onClick={() => setShowToken((value) => !value)}
									title={showToken ? "Hide token" : "Show token"}
									type="button"
								>
									{showToken ? (
										<EyeOff className="size-4" />
									) : (
										<Eye className="size-4" />
									)}
								</button>
							</div>
							<p
								className={cn(
									"mt-1.5 text-xs",
									tokenState?.valid
										? "text-primary"
										: tokenState
											? "text-destructive"
											: "text-muted-foreground/70",
								)}
							>
								{tokenState === null
									? "Token not verified yet."
									: tokenState.valid
										? `Connected as ${tokenState.user ?? "unknown user"}.`
										: "Token invalid — check that you copied it correctly."}
							</p>
						</div>
					)}
				</div>
			</section>

			{/* Discord */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Discord</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Rich presence</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Show the song you're listening to on your Discord profile, with
								cover art and links to the song, album and artist. Discord must
								be running for the presence to appear.
							</p>
						</div>
						<button
							aria-label="Toggle Discord rich presence"
							aria-pressed={settings.discordRpc}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.discordRpc ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ discordRpc: !settings.discordRpc })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.discordRpc && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>

			{/* Storage */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">Storage</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Synced caches</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Clear the locally stored playlists and artist data. They will be
								fetched again on next visit.
							</p>
						</div>
						<button
							className={cn(
								"flex h-9 shrink-0 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors duration-200",
								cleared
									? "border-primary/40 text-primary"
									: "border-foreground/12 text-muted-foreground hover:border-destructive/40 hover:text-destructive",
							)}
							onClick={() => {
								clearCaches();
							}}
							type="button"
						>
							<Trash2 className="size-4" />
							{cleared ? "Cleared" : "Clear"}
						</button>
					</div>
				</div>
			</section>

			{/* Updates (desktop only — the plugin doesn't exist on mobile) */}
			{updaterSupported() && <UpdatesSection />}

			{/* Developer */}
			<section className="mt-10">
				<h2 className="mb-3 text-sm font-semibold text-foreground">
					Developer
				</h2>
				<div className="divide-y divide-foreground/6 overflow-hidden rounded-xl border border-foreground/8 bg-card">
					<div className="flex items-center justify-between gap-6 p-4">
						<div className="min-w-0">
							<p className="text-sm font-medium">Developer mode</p>
							<p className="mt-0.5 text-xs text-muted-foreground">
								Add extra copy actions to song context menus (original title,
								video ID, thumbnail URL, raw song data).
							</p>
						</div>
						<button
							aria-label="Toggle developer mode"
							aria-pressed={settings.developerMode}
							className={cn(
								"relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200",
								settings.developerMode ? "bg-primary" : "bg-foreground/15",
							)}
							onClick={() => update({ developerMode: !settings.developerMode })}
							type="button"
						>
							<span
								className={cn(
									"absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200",
									settings.developerMode && "translate-x-5",
								)}
							/>
						</button>
					</div>
				</div>
			</section>
		</div>
	);
}
