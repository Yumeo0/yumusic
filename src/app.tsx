import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
	HouseIcon,
	LibraryIcon,
	LogInIcon,
	Music2,
	Pin,
	SettingsIcon,
	X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	HashRouter,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { ScrollArea } from "@/components/ui/scroll-area";
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
	setQueueOpen,
	toggleNowPlaying,
	toggleQueue,
	useNowPlayingOpen,
	useQueueOpen,
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
	cleanSearchTitle,
	displayTitle,
	formatArtistName,
	formatTitleParts,
	joinArtists,
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
 * Mirrors the current song into Discord rich presence while enabled:
 * cover art + album tooltip (linked), clickable song title and artist,
 * plus playback timestamps that freeze while paused.
 */
function DiscordPresenceSync() {
	const { currentSong, videoElementRef } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [settings] = useSettings();
	const [meta, setMeta] = useState<TrackMeta | null>(null);
	const [mediaDuration, setMediaDuration] = useState(0);

	const songId = currentSong?.id;
	const artist = currentSong?.artist ?? "";
	const title = displayTitle(
		currentSong?.title ?? "",
		settings.titleMode,
		settings.cleanTitles,
		artist,
	);
	const cover = currentSong?.thumbnail ?? "";
	const artistId =
		currentSong?.artistId ?? currentSong?.artists?.find((a) => a.id)?.id;
	const discordEnabled = settings.discordRpc;

	// Track the element's duration reactively: when a song starts, the
	// presence update fires before MSE metadata is parsed (duration NaN),
	// so re-send once durationchange/loadedmetadata deliver the real value.
	// biome-ignore lint/correctness/useExhaustiveDependencies: songId is an intentional reset trigger for the tracked duration
	useEffect(() => {
		setMediaDuration(0);
		const videoEl = videoElementRef?.current;
		if (!videoEl) return;
		const sync = () =>
			setMediaDuration(
				Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
			);
		videoEl.addEventListener("durationchange", sync);
		videoEl.addEventListener("loadedmetadata", sync);
		return () => {
			videoEl.removeEventListener("durationchange", sync);
			videoEl.removeEventListener("loadedmetadata", sync);
		};
	}, [videoElementRef, songId]);

	// Album data arrives from a follow-up fetch; it upgrades the presence
	// (album tooltip/link) once loaded.
	useEffect(() => {
		let cancelled = false;
		setMeta(null);
		if (discordEnabled && songId) {
			getTrackMeta(songId).then((next) => {
				if (!cancelled) setMeta(next);
			});
		}
		return () => {
			cancelled = true;
		};
	}, [discordEnabled, songId]);

	useEffect(() => {
		if (!discordEnabled || !songId) return;
		const videoEl = videoElementRef?.current ?? null;
		const elapsed = videoEl?.currentTime ?? 0;
		invoke("set_discord_activity", {
			track: {
				title,
				artist: formatArtistName(artist),
				album: meta?.album?.name ?? null,
				coverUrl: cover || null,
				songUrl: `https://music.youtube.com/watch?v=${songId}`,
				artistUrl: artistId
					? `https://music.youtube.com/channel/${artistId}`
					: null,
				albumUrl: meta?.album?.id
					? `https://music.youtube.com/playlist?list=${meta.album.id}`
					: null,
				playing: isPlaying,
				elapsedSecs: elapsed,
				durationSecs: mediaDuration,
			},
		}).catch((error) => {
			console.warn("[discord] presence update failed:", error);
		});
	}, [
		discordEnabled,
		songId,
		title,
		artist,
		cover,
		artistId,
		isPlaying,
		mediaDuration,
		meta,
		videoElementRef,
	]);

	// Turning the feature off drops the presence immediately.
	useEffect(() => {
		if (!discordEnabled) {
			invoke("clear_discord_activity").catch(() => undefined);
		}
	}, [discordEnabled]);

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
	const {
		currentSong,
		currentIndex,
		hasNext,
		next,
		previous,
		videoElementRef,
	} = usePlayer();
	const { isPlaying, toggle } = usePlayerControls();
	const [settings] = useSettings();

	// Next may roll into the autoplay radio once the queue ends, matching the
	// in-app button; previous stays queue-only so it never rewrites the queue
	// from history.
	const canGoNext = hasNext;
	const canStepPrevious = currentIndex > 0;

	// Media key presses are handled with the latest player state.
	const live = useRef({
		canGoNext,
		canStepPrevious,
		isPlaying,
		next,
		previous,
		toggle,
		videoElementRef,
	});
	live.current = {
		canGoNext,
		canStepPrevious,
		isPlaying,
		next,
		previous,
		toggle,
		videoElementRef,
	};

	useEffect(() => {
		if (!isTauri()) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		listen<MediaControlPayload>("media-control", (event) => {
			const { action, position } = event.payload;
			const video = live.current.videoElementRef?.current;
			switch (action) {
				case "play":
					if (!live.current.isPlaying) live.current.toggle();
					break;
				case "pause":
				case "stop":
					if (live.current.isPlaying) live.current.toggle();
					break;
				case "toggle":
					live.current.toggle();
					break;
				case "next":
					if (live.current.canGoNext) void live.current.next();
					break;
				case "previous":
					if (live.current.canStepPrevious) void live.current.previous();
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
	}, []);

	const title = currentSong
		? displayTitle(
				currentSong.title,
				settings.titleMode,
				settings.cleanTitles,
				currentSong.artist,
			)
		: null;
	const artist = currentSong ? formatArtistName(currentSong.artist) : null;
	const cover = currentSong?.thumbnail ?? null;
	const songId = currentSong?.id ?? null;

	// Snapshot for the native session; the same cover the fullscreen player
	// shows (the OS fetches the URL itself).
	const push = useCallback(() => {
		if (!isTauri()) return;
		const video = videoElementRef?.current;
		const duration =
			video && Number.isFinite(video.duration) && video.duration > 0
				? video.duration
				: null;
		invoke("update_media_session", {
			snapshot: {
				artist,
				canGoNext,
				canGoPrevious: canStepPrevious,
				coverUrl: cover,
				duration,
				id: songId,
				playing: isPlaying,
				position: video?.currentTime ?? 0,
				title,
			},
		}).catch(() => undefined);
	}, [
		artist,
		canGoNext,
		canStepPrevious,
		cover,
		isPlaying,
		songId,
		title,
		videoElementRef,
	]);

	useEffect(() => {
		push();
	}, [push]);

	// Position ticks keep the OS progress bar moving while playing.
	useEffect(() => {
		if (!isPlaying) return;
		const timer = window.setInterval(push, 5000);
		return () => window.clearInterval(timer);
	}, [isPlaying, push]);

	return null;
}

/**
 * Scrobbles finished plays to ListenBrainz: a "playing now" listen when
 * playback starts and a single listen (with the MusicBrainz recording MBID,
 * looked up once per track and cached) once half the song — max 4 minutes —
 * has actually been listened to.
 */
function ListenBrainzSync() {
	const { currentSong, videoElementRef } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [settings] = useSettings();
	const [meta, setMeta] = useState<TrackMeta | null>(null);

	const songId = currentSong?.id;
	const token = settings.listenbrainzToken.trim();
	const enabled = settings.listenbrainz && token.length > 0;

	const startedAtRef = useRef<number | null>(null);

	/**
	 * Scrobble metadata in the track's original language: the title without
	 * its translated part and the primary artist credit (both from the
	 * original-language queue fetch when available).
	 */
	const scrobbleMetadata = useCallback((): {
		trackName: string;
		artistName: string;
		mainTitle: string;
		feats: string[];
	} => {
		const parts = formatTitleParts(
			currentSong?.title ?? "",
			"original",
			settings.cleanTitles,
			currentSong?.artist,
		);
		const trackName =
			meta?.originalTitle ??
			(parts.feats.length > 0
				? `${parts.main} (feat. ${joinArtists(parts.feats)})`
				: parts.main);
		const artistName = meta?.originalArtist ?? currentSong?.artist ?? "";
		return {
			trackName,
			artistName,
			mainTitle: parts.main,
			feats: parts.feats,
		};
	}, [currentSong, meta, settings.cleanTitles]);
	const scrobbleMetadataRef = useRef(scrobbleMetadata);
	scrobbleMetadataRef.current = scrobbleMetadata;

	// Album name for the release metadata.
	useEffect(() => {
		let cancelled = false;
		setMeta(null);
		if (enabled && songId) {
			getTrackMeta(songId).then((next) => {
				if (!cancelled) setMeta(next);
			});
		}
		return () => {
			cancelled = true;
		};
	}, [enabled, songId]);

	// New track — reset the listen-start timestamp so skipping songs doesn't
	// submit a stale listenedAt.
	// biome-ignore lint/correctness/useExhaustiveDependencies: songId/enabled are intentional reset triggers
	useEffect(() => {
		startedAtRef.current = null;
	}, [songId, enabled]);

	// Remember when playback started; used as the scrobble's listenedAt.
	useEffect(() => {
		if (!enabled || !songId || !isPlaying) return;
		if (startedAtRef.current === null) {
			startedAtRef.current = Math.floor(Date.now() / 1000);
		}
	}, [enabled, songId, isPlaying]);

	// The shared listening session drives both the "playing now" submission
	// (grace period reached) and the scrobble (half the track listened), so
	// the timing stays consistent with the YouTube watch-history pings.
	useEffect(() => {
		if (!enabled || !songId || !currentSong) return;
		return listeningSession.subscribe((event, eventSongId) => {
			if (eventSongId !== songId) return;
			const names = scrobbleMetadataRef.current();
			const videoEl = videoElementRef?.current ?? null;
			const duration =
				videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;

			if (event === "established") {
				// Resolve the recording MBID for the playing_now listen as well —
				// it links the card and gives it cover art, and pre-warms the
				// cache for the scrobble. Submits without MBIDs if lookup fails.
				const submit = async () => {
					const mbids = await findRecording(
						cleanSearchTitle(
							meta?.originalTitle ?? names.mainTitle,
							names.artistName,
						),
						names.artistName,
						duration,
						names.feats,
					).catch(() => null);
					await submitListen({
						token,
						trackName: names.trackName,
						artistName: names.artistName,
						album: meta?.album?.name,
						mbids,
					});
				};
				submit().catch((error) => {
					console.warn("[listenbrainz] playing_now failed:", error);
				});
				return;
			}

			const listenedAt = startedAtRef.current ?? Math.floor(Date.now() / 1000);
			const submit = async () => {
				const mbids = await findRecording(
					cleanSearchTitle(
						meta?.originalTitle ?? names.mainTitle,
						names.artistName,
					),
					names.artistName,
					duration,
					names.feats,
				).catch(() => null);
				await submitListen({
					token,
					trackName: names.trackName,
					artistName: names.artistName,
					album: meta?.album?.name,
					mbids,
					listenedAt,
				});
			};
			submit().catch((error) => {
				console.warn("[listenbrainz] scrobble failed:", error);
			});
		});
	}, [enabled, songId, currentSong, token, meta, videoElementRef]);

	return null;
}

/** Recolors the app accent from the current song's thumbnail. */
function AmbientSync() {
	const { currentSong } = usePlayer();
	const ambient = useAmbientColor(currentSong?.thumbnail);

	useEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--primary", ambient);
		root.style.setProperty("--accent", ambient);
		root.style.setProperty("--ring", ambient);
	}, [ambient]);

	return null;
}

function NowPlayingOverlay() {
	const isNowPlayingOpen = useNowPlayingOpen();
	const isQueueOpen = useQueueOpen();
	const overlayRef = useRef<HTMLDivElement>(null);
	useNowPlayingMotion(overlayRef, isNowPlayingOpen);
	// Dragging down on the fullscreen player minimizes it — but only while the
	// queue is closed: with the sheet open, the same swipe drags the queue.
	// The scrollable lyrics column opts out so it keeps scrolling normally.
	const dismissGesture = useNowPlayingSwipe(false);

	// Escape closes the queue first, then the fullscreen view
	useEffect(() => {
		if (!isNowPlayingOpen) return;
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
	}, [isNowPlayingOpen, isQueueOpen]);

	return (
		<div
			aria-hidden={!isNowPlayingOpen}
			className="np-overlay invisible fixed inset-0 z-50 will-change-transform"
			inert={!isNowPlayingOpen}
			ref={overlayRef}
			style={{ transform: "translateY(var(--np-slide, 0px))" }}
			{...dismissGesture}
		>
			<NowPlayingPage
				isQueueOpen={isQueueOpen}
				onClose={toggleNowPlaying}
				onToggleQueue={toggleQueue}
			/>
		</div>
	);
}

function Layout() {
	const [isLoggedIn, setIsLoggedIn] = useState(false);
	const [userProfile, setUserProfile] = useState<{
		name?: string;
		photo?: string;
	} | null>(null);

	useEffect(() => {
		const checkLogin = async () => {
			const cookie = await window.electron.getCookie();
			if (cookie) {
				setIsLoggedIn(true);
				await getYoutubeClient(cookie);
				const profile = await getUserProfile();
				if (profile) {
					setUserProfile(profile);
				}
			}
		};
		checkLogin();
	}, []);

	const handleLogin = async () => {
		const cookie = await window.electron.login();
		if (!cookie) return;
		// Rebuild the shared client with the new session, then reload so every
		// mounted view (home feed, library, profile) refetches authenticated
		// data — effects that already ran against the signed-out client would
		// otherwise never refresh.
		await getYoutubeClient(cookie);
		window.location.reload();
	};

	const handleLogout = async () => {
		await window.electron.logout();
		setIsLoggedIn(false);
		setUserProfile(null);
		window.location.reload();
	};

	return (
		<PlayerProvider>
			<AppShell
				handleLogin={handleLogin}
				handleLogout={handleLogout}
				isLoggedIn={isLoggedIn}
				userProfile={userProfile}
			/>
		</PlayerProvider>
	);
}

/** Rendered inside PlayerProvider so it can consume player state. */
function AppShell({
	isLoggedIn,
	userProfile,
	handleLogin,
	handleLogout,
}: {
	isLoggedIn: boolean;
	userProfile: { name?: string; photo?: string } | null;
	handleLogin: () => void;
	handleLogout: () => void;
}) {
	const location = useLocation();
	const navigate = useNavigate();
	const { pinned, unpin } = usePinnedPlaylists();
	const { currentSong } = usePlayer();

	// Load the stored downloads so the player can play them from disk, and
	// drop caches from older app versions (they survive upgrades and would
	// otherwise keep occupying localStorage quota until writes start failing).
	useEffect(() => {
		pruneStaleCacheVersions();
		void hydrateDownloads();
	}, []);

	// Pinned entries store their cover URL as it was when pinned; heal it from
	// the cached library on startup so a dead URL (older versions saved tiny
	// raw variants that no longer resolve) doesn't leave the sidebar artwork
	// broken until the playlists page is visited.
	useEffect(() => {
		const cached = readCache<LibraryPlaylist[]>(LIBRARY_CACHE_KEY);
		if (cached && cached.data.length > 0) {
			reconcilePinnedPlaylists(cached.data);
		}
	}, []);

	return (
		<>
			<AmbientSync />
			<DiscordPresenceSync />
			<ListenBrainzSync />
			<MediaSessionSync />
			<UpdateNotifier />
			<Titlebar />
			<div
				className={cn(
					"flex overflow-hidden bg-background text-foreground",
					IS_MOBILE ? "h-app" : "h-[calc(100vh-2.25rem)]",
				)}
			>
				{/* ── Sidebar (desktop) ───────────────────────── */}
				<aside className="hidden w-70 shrink-0 flex-col border-r border-foreground/6 bg-sidebar md:flex">
					<div
						className={cn(
							"flex min-h-0 flex-1 flex-col px-4 pt-6",
							currentSong && "pb-26",
						)}
					>
						{/* Account — kept at the top of the sidebar */}
						<div className="pb-3">
							{isLoggedIn ? (
								<UserMenu onLogout={handleLogout} user={userProfile || {}} />
							) : (
								<button
									className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-foreground/5 hover:text-foreground"
									onClick={handleLogin}
									type="button"
								>
									<LogInIcon className="size-5" />
									<span>Log In</span>
								</button>
							)}
						</div>

						<nav className="space-y-1">
							<SidebarItem
								icon={<HouseIcon className="size-4.5" strokeWidth={2.2} />}
								isActive={
									location.pathname === "/" || location.pathname === "/home"
								}
								label="Home"
								onClick={() => navigate("/")}
							/>
							<SidebarItem
								icon={<LibraryIcon className="size-4.5" strokeWidth={2.2} />}
								isActive={location.pathname === "/playlists"}
								label="Playlists"
								onClick={() => navigate("/playlists")}
							/>
							<SidebarItem
								icon={<SettingsIcon className="size-4.5" strokeWidth={2.2} />}
								isActive={location.pathname.startsWith("/settings")}
								label="Settings"
								onClick={() => navigate("/settings")}
							/>
						</nav>

						{/* Pinned playlists — separated from the nav above */}
						{pinned.length > 0 && (
							<div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-foreground/6 pt-3">
								<div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
									<Pin className="size-3" />
									<span>Pinned</span>
								</div>
								<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2 scrollbar-thin">
									{pinned.map((playlist) => {
										const isActive =
											location.pathname === `/playlists/${playlist.id}`;
										return (
											<PlaylistContextMenu
												isPinned
												key={playlist.id}
												onTogglePinned={() => unpin(playlist.id)}
												playlist={playlist}
											>
												<div className="group/pin relative rounded-xl">
													<button
														className={cn(
															"flex w-full items-center gap-3 rounded-xl py-2 pr-8 pl-3 text-sm transition-colors duration-200",
															isActive
																? "bg-primary/12 text-primary"
																: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
														)}
														onClick={() =>
															navigate(`/playlists/${playlist.id}`)
														}
														type="button"
													>
														<PinnedThumbnail
															key={playlist.thumbnail ?? ""}
															thumbnail={playlist.thumbnail}
														/>
														<span className="truncate">{playlist.title}</span>
													</button>
													<button
														aria-label={`Unpin ${playlist.title}`}
														className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/10 hover:text-foreground group-hover/pin:opacity-100"
														onClick={() => unpin(playlist.id)}
														type="button"
													>
														<X className="size-3.5" />
													</button>
												</div>
											</PlaylistContextMenu>
										);
									})}
								</div>
							</div>
						)}

						{/* Download queue — lives at the bottom of the rail */}
						<div className="mt-auto pt-3 pb-4">
							<div className="border-t border-foreground/6 pt-3">
								<DownloadQueueButton />
							</div>
						</div>
					</div>
				</aside>

				{/* ── Main content ────────────────────────────── */}
				<main className="relative flex-1 overflow-hidden">
					<ScrollArea className="h-full">
						{/* Extra top/bottom room on mobile: status-bar safe area,
						    plus nav bar + player clearance */}
						<div className="max-md:pt-(--safe-area-top) pb-44 md:pb-32">
							<div className="animate-page-in" key={location.pathname}>
								<Routes>
									<Route element={<HomePage />} path="/" />
									<Route element={<HomePage />} path="/home" />
									<Route element={<PlaylistsPage />} path="/playlists" />
									<Route element={<PlaylistDetails />} path="/playlists/:id" />
									<Route element={<ArtistPage />} path="/artist/:id" />
									<Route
										element={
											<SettingsPage
												handleLogin={handleLogin}
												handleLogout={handleLogout}
												isLoggedIn={isLoggedIn}
												userProfile={userProfile}
											/>
										}
										path="/settings"
									/>
								</Routes>
							</div>
						</div>
					</ScrollArea>
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
				className="fixed top-[calc(var(--safe-area-top)+0.5rem)] right-3 z-40 md:hidden"
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
function PinnedThumbnail({ thumbnail }: { thumbnail: string | null }) {
	const [failed, setFailed] = useState(false);

	if (!thumbnail || failed) {
		return <Music2 className="size-4 shrink-0" />;
	}
	return (
		<img
			alt=""
			className="size-5 shrink-0 rounded object-cover"
			onError={() => setFailed(true)}
			src={proxiedImageUrl(thumbnail)}
		/>
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
			className="fixed inset-x-0 bottom-0 z-45 flex min-h-[calc(3.75rem+var(--safe-area-bottom))] items-stretch border-t border-foreground/8 bg-sidebar/95 pb-(--safe-area-bottom) backdrop-blur-xl md:hidden"
			data-mobile-nav
		>
			<MobileNavItem
				icon={<HouseIcon className="size-5" strokeWidth={2.2} />}
				isActive={location.pathname === "/" || location.pathname === "/home"}
				label="Home"
				onClick={() => navigate("/")}
			/>
			<MobileNavItem
				icon={<LibraryIcon className="size-5" strokeWidth={2.2} />}
				isActive={location.pathname.startsWith("/playlists")}
				label="Playlists"
				onClick={() => navigate("/playlists")}
			/>
			<MobileNavItem
				icon={<SettingsIcon className="size-5" strokeWidth={2.2} />}
				isActive={location.pathname.startsWith("/settings")}
				label="Settings"
				onClick={() => navigate("/settings")}
			/>
		</nav>
	);
}

function MobileNavItem({ icon, label, isActive, onClick }: SidebarItemProps) {
	return (
		<button
			className={cn(
				"flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-200 active:scale-95",
				isActive ? "text-primary" : "text-muted-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

function App() {
	return (
		<HashRouter>
			<Layout />
		</HashRouter>
	);
}

interface SidebarItemProps {
	icon: React.ReactNode;
	label: string;
	isActive: boolean;
	onClick: () => void;
}

function SidebarItem({ icon, label, isActive, onClick }: SidebarItemProps) {
	return (
		<button
			className={cn(
				"flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200",
				isActive
					? "bg-primary/12 text-primary"
					: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
			)}
			onClick={onClick}
			type="button"
		>
			{icon}
			<span>{label}</span>
		</button>
	);
}

const root = createRoot(document.body);
root.render(
	<div style={{ isolation: "isolate" }}>
		<App />
	</div>,
);
