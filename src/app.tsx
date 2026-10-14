import {
	HouseIcon,
	LibraryIcon,
	LogInIcon,
	Music2,
	Pin,
	SettingsIcon,
	X,
} from "@lucide/solid";
import {
	createRouter,
	hashHistory,
	useLocation,
	useNavigate,
} from "@solidjs/router";
import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	createEffect,
	createSignal,
	For,
	onSettled,
	Show,
	untrack,
} from "solid-js";
import { Titlebar } from "./components/app/titlebar";
import { Toaster } from "./components/app/toaster";
import { UpdateNotifier } from "./components/app/updates";
import { UserMenu } from "./components/app/user-menu";
import { DownloadQueueButton } from "./components/downloads/download-queue";
import { Player } from "./components/player/player";
import { PlaylistContextMenu } from "./components/playlist/playlist-menu";
import { QueuePanel } from "./components/queue/queue-panel";
import { LinkPreviewDialog } from "./components/song/link-preview-dialog";
import {
	PlayerProvider,
	usePlayer,
	usePlayerControls,
} from "./contexts/player-context";
import { hydrateDownloads } from "./lib/downloads/downloads";
import {
	useNowPlayingMotion,
	useNowPlayingSwipe,
} from "./lib/motion/now-playing-motion";
import { listeningSession } from "./lib/player/listening";
import {
	nowPlayingOpen,
	queueOpen,
	setQueueOpen,
	toggleNowPlaying,
	toggleQueue,
} from "./lib/player/player-ui";
import { findRecording, submitListen } from "./lib/services/listenbrainz";
import {
	reconcilePinnedPlaylists,
	usePinnedPlaylists,
} from "./lib/stores/pinned";
import {
	LIBRARY_CACHE_KEY,
	pruneStaleCacheVersions,
	readCache,
} from "./lib/stores/playlist-cache";
import { useSettings } from "./lib/stores/settings";
import { useAmbientColor } from "./lib/utils/hooks";
import { IS_MOBILE, proxiedImageUrl } from "./lib/utils/tauri";
import {
	displayTitle,
	formatArtistName,
	scrobbleTitle,
} from "./lib/utils/title";
import { cn } from "./lib/utils/utils";
import {
	getTrackMeta,
	getUserProfile,
	getYoutubeClient,
	type LibraryPlaylist,
	type TrackMeta,
} from "./lib/youtube/youtube-client";
import ArtistPage from "./pages/artist";
import HomePage from "./pages/home";
import { NowPlayingPage } from "./pages/now-playing";
import PlaylistsPage, { PlaylistDetails } from "./pages/playlists";
import SettingsPage from "./pages/settings";

/**
 * Login state lives at module scope: the router's root (`Layout`) owns the
 * session check, while the routed settings page renders from the same state.
 */
const [isLoggedIn, setIsLoggedIn] = createSignal(false);
const [userProfile, setUserProfile] = createSignal<{
	name?: string;
	photo?: string;
} | null>(null);
let authChecked = false;

async function checkLogin() {
	const cookie = await window.electron.getCookie();
	if (cookie) {
		setIsLoggedIn(true);
		await getYoutubeClient(cookie);
		const profile = await getUserProfile();
		if (profile) {
			setUserProfile(profile);
		}
	}
}

async function handleLogin() {
	const cookie = await window.electron.login();
	if (!cookie) return;
	// Rebuild the shared client with the new session, then reload so every
	// mounted view (home feed, library, profile) refetches authenticated
	// data — effects that already ran against the signed-out client would
	// otherwise never refresh.
	await getYoutubeClient(cookie);
	window.location.reload();
}

async function handleLogout() {
	await window.electron.logout();
	setIsLoggedIn(false);
	setUserProfile(null);
	window.location.reload();
}

/**
 * Mirrors the current song into Discord rich presence while enabled:
 * cover art + album tooltip (linked), clickable song title and artist,
 * plus playback timestamps that freeze while paused.
 */
function DiscordPresenceSync() {
	const player = usePlayer();
	const controls = usePlayerControls();
	const [settings] = useSettings();
	const [meta, setMeta] = createSignal<TrackMeta | null>(null);
	const [mediaDuration, setMediaDuration] = createSignal(0);

	const songId = () => player.currentSong()?.id;
	const artist = () => player.currentSong()?.artist ?? "";
	const title = () =>
		displayTitle(
			player.currentSong()?.title ?? "",
			// Uploader videos keep their raw title (no original/translation split).
			player.currentSong()?.upload ? "both" : settings.titleMode,
			settings.cleanTitles,
			artist(),
		);
	const cover = () => player.currentSong()?.thumbnail ?? "";
	const artistId = () =>
		player.currentSong()?.artistId ??
		player.currentSong()?.artists?.find((a) => a.id)?.id;
	const discordEnabled = () => settings.discordRpc;

	// Track the element's duration reactively: when a song starts, the
	// presence update fires before MSE metadata is parsed (duration NaN),
	// so re-send once durationchange/loadedmetadata deliver the real value.
	// A crossfade preloads the next track onto the idle deck early, so its
	// duration events have already fired by the time the handover makes it
	// current — read the value once at attach time to catch those.
	createEffect(
		() => songId(),
		() => {
			setMediaDuration(0);
			const videoEl = player.videoElement();
			if (!videoEl) return;
			const sync = () =>
				setMediaDuration(
					Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
				);
			sync();
			videoEl.addEventListener("durationchange", sync);
			videoEl.addEventListener("loadedmetadata", sync);
			return () => {
				videoEl.removeEventListener("durationchange", sync);
				videoEl.removeEventListener("loadedmetadata", sync);
			};
		},
	);

	// Album data arrives from a follow-up fetch; it upgrades the presence
	// (album tooltip/link) once loaded.
	createEffect(
		() => [discordEnabled(), songId()] as const,
		([enabled, id]) => {
			let cancelled = false;
			setMeta(null);
			if (enabled && id) {
				getTrackMeta(id).then((next) => {
					if (!cancelled) setMeta(next);
				});
			}
			return () => {
				cancelled = true;
			};
		},
	);

	// The player's metadata length (YouTube's listing) is preferred over the
	// media element's duration, which reports a fraction less; it is also the
	// only total available when a crossfade preload beat the element listeners.
	const durationSecs = () => {
		const known = player.duration();
		return known > 0 ? known : mediaDuration();
	};

	createEffect(
		() => ({
			artist: artist(),
			artistId: artistId(),
			cover: cover(),
			discordEnabled: discordEnabled(),
			durationSecs: durationSecs(),
			isPlaying: controls.isPlaying(),
			meta: meta(),
			songId: songId(),
			title: title(),
		}),
		(snapshot) => {
			if (!snapshot.discordEnabled || !snapshot.songId) return;
			const videoEl = player.videoElement();
			const elapsed = videoEl?.currentTime ?? 0;
			invoke("set_discord_activity", {
				track: {
					title: snapshot.title,
					artist: formatArtistName(snapshot.artist),
					album: snapshot.meta?.album?.name ?? null,
					coverUrl: snapshot.cover || null,
					songUrl: `https://music.youtube.com/watch?v=${snapshot.songId}`,
					artistUrl: snapshot.artistId
						? `https://music.youtube.com/channel/${snapshot.artistId}`
						: null,
					albumUrl: snapshot.meta?.album?.id
						? `https://music.youtube.com/playlist?list=${snapshot.meta.album.id}`
						: null,
					playing: snapshot.isPlaying,
					elapsedSecs: elapsed,
					durationSecs: snapshot.durationSecs,
				},
			}).catch((error) => {
				console.warn("[discord] presence update failed:", error);
			});
		},
	);

	// Turning the feature off drops the presence immediately.
	createEffect(
		() => discordEnabled(),
		(enabled) => {
			if (!enabled) {
				invoke("clear_discord_activity").catch(() => undefined);
			}
		},
	);

	return null;
}

interface MediaControlPayload {
	action: string;
	position?: number;
}

/**
 * Bridges playback to the native OS media session (Windows SMTC, macOS Now
 * Playing, Linux MPRIS — see the Rust side). Owning the session natively is
 * what gives the system the app's real name and icon; WebView2's own
 * MediaSession shows up as "Unknown App". The hardware media keys arrive as
 * `media-control` events.
 */
function MediaSessionSync() {
	const player = usePlayer();
	const controls = usePlayerControls();
	const [settings] = useSettings();

	// Next may roll into the autoplay radio once the queue ends, matching the
	// in-app button; previous stays queue-only so it never rewrites the queue
	// from history.
	const canGoNext = () => player.hasNext();
	const canStepPrevious = () => player.currentIndex() > 0;

	// Media key presses are handled with the latest player state: the handler
	// reads the accessors directly, so it never goes stale.
	onSettled(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		listen<MediaControlPayload>("media-control", (event) => {
			const { action, position } = event.payload;
			const video = player.videoElement();
			switch (action) {
				case "play":
					if (!controls.isPlaying()) controls.toggle();
					break;
				case "pause":
				case "stop":
					if (controls.isPlaying()) controls.toggle();
					break;
				case "toggle":
					controls.toggle();
					break;
				case "next":
					if (canGoNext()) void player.next();
					break;
				case "previous":
					if (canStepPrevious()) void player.previous();
					break;
				case "seek-by":
					if (video && typeof position === "number") {
						video.currentTime = Math.max(0, video.currentTime + position);
					}
					break;
				case "set-position":
					if (video && typeof position === "number") {
						video.currentTime = position;
					}
					break;
			}
		}).then((fn) => {
			if (disposed) fn();
			else unlisten = fn;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	// Snapshot for the native session; the same cover the fullscreen player
	// shows (the OS fetches the URL itself).
	const push = () => {
		if (!isTauri()) return;
		const video = player.videoElement();
		const duration =
			video && Number.isFinite(video.duration) && video.duration > 0
				? video.duration
				: null;
		const song = player.currentSong();
		const title = song
			? displayTitle(
					song.title,
					// Uploader videos keep their raw title.
					song.upload ? "both" : settings.titleMode,
					settings.cleanTitles,
					song.artist,
				)
			: null;
		invoke("update_media_session", {
			snapshot: {
				artist: song ? formatArtistName(song.artist) : null,
				canGoNext: canGoNext(),
				canGoPrevious: canStepPrevious(),
				coverUrl: song?.thumbnail ?? null,
				duration,
				id: song?.id ?? null,
				playing: controls.isPlaying(),
				position: video?.currentTime ?? 0,
				title,
			},
		}).catch(() => undefined);
	};

	// Re-publish on any change that shapes the snapshot; `push` reads the
	// live values at call time, so the call is deliberately untracked — the
	// compute below tracks everything the effect must react to.
	createEffect(
		() => ({
			canGoNext: canGoNext(),
			canStepPrevious: canStepPrevious(),
			cover: player.currentSong()?.thumbnail ?? null,
			isPlaying: controls.isPlaying(),
			songId: player.currentSong()?.id ?? null,
			titleMode: settings.titleMode,
			cleanTitles: settings.cleanTitles,
		}),
		() => {
			untrack(push);
		},
	);

	// Position ticks keep the OS progress bar moving while playing.
	createEffect(
		() => controls.isPlaying(),
		(playing) => {
			if (!playing) return;
			const timer = window.setInterval(push, 5000);
			return () => window.clearInterval(timer);
		},
	);

	return null;
}

/**
 * Scrobbles finished plays to ListenBrainz: a "playing now" listen when
 * playback starts and a single listen (with the MusicBrainz recording MBID,
 * looked up once per track and cached) once half the song — max 4 minutes —
 * has actually been listened to.
 */
function ListenBrainzSync() {
	const player = usePlayer();
	const controls = usePlayerControls();
	const [settings] = useSettings();
	const [meta, setMeta] = createSignal<TrackMeta | null>(null);

	const songId = () => player.currentSong()?.id;
	const token = () => settings.listenbrainzToken.trim();
	const enabled = () => settings.listenbrainz && token().length > 0;

	let startedAt: number | null = null;

	/**
	 * Scrobble metadata in the track's original language: the uploader's
	 * locale-independent title parsed like the display pipeline — always
	 * cleaned, since catalog metadata doesn't follow the display preference —
	 * and the primary artist credit, without channel/group decorations
	 * ("Apricot (Froot)" → "Apricot") so the submission and the MusicBrainz
	 * lookup use the artist's catalog name.
	 */
	const scrobbleMetadata = (): {
		trackName: string;
		artistName: string;
		mainTitle: string;
		feats: string[];
	} => {
		const song = player.currentSong();
		const catalogMeta = meta();
		const { main, feats, trackName } = scrobbleTitle(
			catalogMeta?.originalTitle ?? song?.title ?? "",
			song?.artist,
		);
		const artistName = formatArtistName(
			catalogMeta?.originalArtist ?? song?.artist ?? "",
		);
		return {
			trackName,
			artistName,
			mainTitle: main,
			feats,
		};
	};

	// Album name for the release metadata.
	createEffect(
		() => [enabled(), songId()] as const,
		([isEnabled, id]) => {
			let cancelled = false;
			setMeta(null);
			if (isEnabled && id) {
				getTrackMeta(id).then((next) => {
					if (!cancelled) setMeta(next);
				});
			}
			return () => {
				cancelled = true;
			};
		},
	);

	// New track — reset the listen-start timestamp so skipping songs doesn't
	// submit a stale listenedAt.
	createEffect(
		() => [songId(), enabled()] as const,
		() => {
			startedAt = null;
		},
	);

	// Remember when playback started; used as the scrobble's listenedAt.
	createEffect(
		() => [enabled(), songId(), controls.isPlaying()] as const,
		([isEnabled, id, playing]) => {
			if (!isEnabled || !id || !playing) return;
			if (startedAt === null) {
				startedAt = Math.floor(Date.now() / 1000);
			}
		},
	);

	// The shared listening session drives both the "playing now" submission
	// (grace period reached) and the scrobble (half the track listened), so
	// the timing stays consistent with the YouTube watch-history pings.
	createEffect(
		() => [enabled(), songId(), player.currentSong(), token(), meta()] as const,
		([isEnabled, id]) => {
			if (!isEnabled || !id) return;
			return listeningSession.subscribe((event, eventSongId) => {
				if (eventSongId !== id) return;
				const names = scrobbleMetadata();
				const videoEl = player.videoElement();
				const duration =
					videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;

				if (event === "established") {
					// Resolve the recording MBID for the playing_now listen as well —
					// it links the card and gives it cover art, and pre-warms the
					// cache for the scrobble. Submits without MBIDs if lookup fails.
					const submit = async () => {
						const mbids = await findRecording(
							names.mainTitle,
							names.artistName,
							duration,
							names.feats,
						).catch(() => null);
						await submitListen({
							token: token(),
							trackName: names.trackName,
							artistName: names.artistName,
							album: meta()?.album?.name,
							mbids,
						});
					};
					submit().catch((error) => {
						console.warn("[listenbrainz] playing_now failed:", error);
					});
					return;
				}

				const listenedAt = startedAt ?? Math.floor(Date.now() / 1000);
				const submit = async () => {
					const mbids = await findRecording(
						names.mainTitle,
						names.artistName,
						duration,
						names.feats,
					).catch(() => null);
					await submitListen({
						token: token(),
						trackName: names.trackName,
						artistName: names.artistName,
						album: meta()?.album?.name,
						mbids,
						listenedAt,
					});
				};
				submit().catch((error) => {
					console.warn("[listenbrainz] scrobble failed:", error);
				});
			});
		},
	);

	return null;
}

/** Recolors the app accent from the current song's thumbnail. */
function AmbientSync() {
	const player = usePlayer();
	const ambient = useAmbientColor(() => player.currentSong()?.thumbnail);

	createEffect(
		() => ambient(),
		(ambient) => {
			const root = document.documentElement;
			root.style.setProperty("--primary", ambient);
			root.style.setProperty("--accent", ambient);
			root.style.setProperty("--ring", ambient);
		},
	);

	return null;
}

function NowPlayingOverlay() {
	let overlayEl!: HTMLDivElement;
	useNowPlayingMotion(() => overlayEl, nowPlayingOpen);
	// Dragging down on the fullscreen player minimizes it — but only while the
	// queue is closed: with the sheet open, the same swipe drags the queue.
	// The scrollable lyrics column opts out so it keeps scrolling normally.
	const dismissGesture = useNowPlayingSwipe(false);

	// Escape closes the queue first, then the fullscreen view
	createEffect(
		() => [nowPlayingOpen(), queueOpen()] as const,
		([isOpen, isQueueOpen]) => {
			if (!isOpen) return;
			const handler = (e: KeyboardEvent) => {
				if (e.key !== "Escape") return;
				if (isQueueOpen) {
					setQueueOpen(false);
				} else {
					toggleNowPlaying();
				}
			};
			window.addEventListener("keydown", handler);
			return () => window.removeEventListener("keydown", handler);
		},
	);

	return (
		<div
			aria-hidden={nowPlayingOpen() ? "false" : "true"}
			class="np-overlay invisible fixed inset-0 z-50 will-change-transform"
			inert={!nowPlayingOpen()}
			onTouchCancel={dismissGesture.onTouchCancel}
			onTouchEnd={dismissGesture.onTouchEnd}
			onTouchMove={dismissGesture.onTouchMove}
			ref={(el) => {
				overlayEl = el;
				dismissGesture.attach(el);
			}}
			style={{ transform: "translateY(var(--np-slide, 0px))" }}
		>
			<NowPlayingPage
				isQueueOpen={queueOpen()}
				onClose={toggleNowPlaying}
				onToggleQueue={toggleQueue}
			/>
		</div>
	);
}

function Layout(props: { children?: JSX.Element }) {
	onSettled(() => {
		if (authChecked) return;
		authChecked = true;
		void checkLogin();
	});

	return (
		<PlayerProvider>
			<AppShell>{props.children}</AppShell>
		</PlayerProvider>
	);
}

/** Router root contents; reads player state, so it lives inside the provider. */
function AppShell(props: { children: JSX.Element }) {
	const location = useLocation();
	const navigate = useNavigate();
	const pinnedState = usePinnedPlaylists();
	const player = usePlayer();

	// Load the stored downloads so the player can play them from disk, and
	// drop caches from older app versions (they survive upgrades and would
	// otherwise keep occupying localStorage quota until writes start failing).
	onSettled(() => {
		pruneStaleCacheVersions();
		void hydrateDownloads();
	});

	// Pinned entries store their cover URL as it was when pinned; heal it from
	// the cached library on startup so a dead URL (older versions saved tiny
	// raw variants that no longer resolve) doesn't leave the sidebar artwork
	// broken until the playlists page is visited.
	onSettled(() => {
		const cached = readCache<LibraryPlaylist[]>(LIBRARY_CACHE_KEY);
		if (cached && cached.data.length > 0) {
			reconcilePinnedPlaylists(cached.data);
		}
	});

	return (
		<>
			<AmbientSync />
			<DiscordPresenceSync />
			<ListenBrainzSync />
			<MediaSessionSync />
			<UpdateNotifier />
			<Titlebar />
			<div
				class={cn(
					"flex overflow-hidden bg-background text-foreground",
					IS_MOBILE ? "h-app" : "h-[calc(100vh-2.25rem)]",
				)}
			>
				{/* ── Sidebar (desktop) ───────────────────────── */}
				<aside class="hidden w-70 shrink-0 flex-col border-r border-foreground/6 bg-sidebar md:flex">
					<div
						class={cn(
							"flex min-h-0 flex-1 flex-col px-4 pt-6",
							player.currentSong() && "pb-26",
						)}
					>
						{/* Account — kept at the top of the sidebar */}
						<div class="pb-3">
							<Show
								fallback={
									<button
										class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-foreground/5 hover:text-foreground"
										onClick={handleLogin}
										type="button"
									>
										<LogInIcon class="size-5" />
										<span>Log In</span>
									</button>
								}
								when={isLoggedIn()}
							>
								<UserMenu onLogout={handleLogout} user={userProfile() || {}} />
							</Show>
						</div>

						<nav class="space-y-1">
							<SidebarItem
								icon={<HouseIcon class="size-4.5" stroke-width={2.2} />}
								isActive={
									location.pathname === "/" || location.pathname === "/home"
								}
								label="Home"
								onClick={() => navigate("/")}
							/>
							<SidebarItem
								icon={<LibraryIcon class="size-4.5" stroke-width={2.2} />}
								isActive={location.pathname === "/playlists"}
								label="Playlists"
								onClick={() => navigate("/playlists")}
							/>
							<SidebarItem
								icon={<SettingsIcon class="size-4.5" stroke-width={2.2} />}
								isActive={location.pathname.startsWith("/settings")}
								label="Settings"
								onClick={() => navigate("/settings")}
							/>
						</nav>

						{/* Pinned playlists — separated from the nav above */}
						<Show when={pinnedState.pinned.length > 0}>
							<div class="mt-3 flex min-h-0 flex-1 flex-col border-t border-foreground/6 pt-3">
								<div class="flex items-center gap-2 px-3 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
									<Pin class="size-3" />
									<span>Pinned</span>
								</div>
								<div class="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2 scrollbar-thin">
									<For each={pinnedState.pinned} keyed={(item) => item.id}>
										{(playlist) => {
											const isActive = () =>
												location.pathname === `/playlists/${playlist().id}`;
											return (
												<PlaylistContextMenu
													isPinned
													onTogglePinned={() =>
														pinnedState.unpin(playlist().id)
													}
													playlist={playlist()}
												>
													<div class="group/pin relative rounded-xl">
														<button
															class={cn(
																"flex w-full items-center gap-3 rounded-xl py-2 pr-8 pl-3 text-sm transition-colors duration-200",
																isActive()
																	? "bg-primary/12 text-primary"
																	: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
															)}
															onClick={() =>
																navigate(`/playlists/${playlist().id}`)
															}
															type="button"
														>
															<Show keyed when={playlist().thumbnail}>
																{(thumbnail) => (
																	<PinnedThumbnail thumbnail={thumbnail} />
																)}
															</Show>
															<span class="truncate">{playlist().title}</span>
														</button>
														<button
															aria-label={`Unpin ${playlist().title}`}
															class="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/10 hover:text-foreground group-hover/pin:opacity-100"
															onClick={() => pinnedState.unpin(playlist().id)}
															type="button"
														>
															<X class="size-3.5" />
														</button>
													</div>
												</PlaylistContextMenu>
											);
										}}
									</For>
								</div>
							</div>
						</Show>

						{/* Download queue — lives at the bottom of the rail */}
						<div class="mt-auto pt-3 pb-4">
							<div class="border-t border-foreground/6 pt-3">
								<DownloadQueueButton />
							</div>
						</div>
					</div>
				</aside>

				{/* ── Main content ────────────────────────────── */}
				<main class="relative flex-1 overflow-hidden">
					<div class="h-full overflow-y-auto">
						{/* Extra top/bottom room on mobile: status-bar safe area,
						    plus nav bar + player clearance */}
						<div class="max-md:pt-(--safe-area-top) pb-44 md:pb-32">
							{/* Recreated per path so the page-in animation replays. */}
							<Show keyed when={location.pathname}>
								{(_path) => <div class="animate-page-in">{props.children}</div>}
							</Show>
						</div>
					</div>
				</main>

				<NowPlayingOverlay />
				<QueuePanel />
				<Player />
				<Toaster />
				<LinkPreviewDialog />
			</div>
			<MobileNav />
			{/* Mobile has no sidebar: the active download queue floats top-right */}
			<DownloadQueueButton
				align="end"
				class="fixed top-[calc(var(--safe-area-top)+0.5rem)] right-3 z-40 md:hidden"
				compact
				side="bottom"
			/>
		</>
	);
}

/**
 * Sidebar artwork for a pinned playlist. The pin stores its cover URL by
 * value, so the image can outlive the URL (replaced covers, dead legacy
 * variants); a failed load degrades to the placeholder icon instead of a
 * broken glyph. Keyed by the URL at the call site, so a reconciled URL gets
 * a fresh attempt.
 */
function PinnedThumbnail(props: { thumbnail: string | null }) {
	const [failed, setFailed] = createSignal(false);

	return (
		<Show
			fallback={<Music2 class="size-4 shrink-0" />}
			when={!failed() && props.thumbnail}
		>
			{(thumbnail) => (
				<img
					alt=""
					class="size-5 shrink-0 rounded object-cover"
					onError={() => setFailed(true)}
					src={proxiedImageUrl(thumbnail())}
				/>
			)}
		</Show>
	);
}

/**
 * Mobile bottom navigation — replaces the desktop sidebar on phones.
 * Sits below the player bar, which lifts above it while a song plays.
 * Account management lives on the settings page.
 */
function MobileNav() {
	const location = useLocation();
	const navigate = useNavigate();

	return (
		<nav
			class="fixed inset-x-0 bottom-0 z-45 flex min-h-[calc(3.75rem+var(--safe-area-bottom))] items-stretch border-t border-foreground/8 bg-sidebar/95 pb-(--safe-area-bottom) backdrop-blur-xl md:hidden"
			data-mobile-nav
		>
			<MobileNavItem
				icon={<HouseIcon class="size-5" stroke-width={2.2} />}
				isActive={location.pathname === "/" || location.pathname === "/home"}
				label="Home"
				onClick={() => navigate("/")}
			/>
			<MobileNavItem
				icon={<LibraryIcon class="size-5" stroke-width={2.2} />}
				isActive={location.pathname.startsWith("/playlists")}
				label="Playlists"
				onClick={() => navigate("/playlists")}
			/>
			<MobileNavItem
				icon={<SettingsIcon class="size-5" stroke-width={2.2} />}
				isActive={location.pathname.startsWith("/settings")}
				label="Settings"
				onClick={() => navigate("/settings")}
			/>
		</nav>
	);
}

function MobileNavItem(props: SidebarItemProps) {
	return (
		<button
			class={cn(
				"flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-200 active:scale-95",
				props.isActive ? "text-primary" : "text-muted-foreground",
			)}
			onClick={props.onClick}
			type="button"
		>
			{props.icon}
			<span>{props.label}</span>
		</button>
	);
}

interface SidebarItemProps {
	icon: JSX.Element;
	label: string;
	isActive: boolean;
	onClick: () => void;
}

function SidebarItem(props: SidebarItemProps) {
	return (
		<button
			class={cn(
				"flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200",
				props.isActive
					? "bg-primary/12 text-primary"
					: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
			)}
			onClick={props.onClick}
			type="button"
		>
			{props.icon}
			<span>{props.label}</span>
		</button>
	);
}

function SettingsRoute() {
	return (
		<SettingsPage
			handleLogin={handleLogin}
			handleLogout={handleLogout}
			isLoggedIn={isLoggedIn()}
			userProfile={userProfile()}
		/>
	);
}

/** The router instance is the provider; the render-prop child is the root
 * layout, which receives the matched route content as `props.children`. */
const Router = createRouter({
	history: hashHistory(),
	routes: [
		{ component: HomePage, path: "/" },
		{ component: HomePage, path: "/home" },
		{ component: PlaylistsPage, path: "/playlists" },
		{ component: PlaylistDetails, path: "/playlists/:id" },
		{ component: ArtistPage, path: "/artist/:id" },
		{ component: SettingsRoute, path: "/settings" },
	],
});

function App() {
	return (
		<Router>{(routeProps) => <Layout>{routeProps.children}</Layout>}</Router>
	);
}

render(
	() => (
		<div style={{ isolation: "isolate" }}>
			<App />
		</div>
	),
	document.body,
);
