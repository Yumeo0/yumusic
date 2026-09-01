import { invoke } from "@tauri-apps/api/core";
import {
	HouseIcon,
	LibraryIcon,
	LogInIcon,
	Music2,
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
import { Player } from "./components/player";
import { QueuePanel } from "./components/queue-panel";
import { UserMenu } from "./components/user-menu";
import { PlayerProvider, usePlayer } from "./contexts/player-context";
import { useAmbientColor } from "./lib/hooks";
import { findRecording, submitListen } from "./lib/listenbrainz";
import { usePinnedPlaylists } from "./lib/pinned";
import { useSettings } from "./lib/settings";
import {
	cleanSearchTitle,
	displayTitle,
	formatTitleParts,
	joinArtists,
} from "./lib/title";
import { cn } from "./lib/utils";
import {
	getTrackMeta,
	getUserProfile,
	getYoutubeClient,
	type TrackMeta,
} from "./lib/youtube-client";
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
	const { currentSong, isPlaying, videoElementRef } = usePlayer();
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
				artist,
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

/**
 * Scrobbles finished plays to ListenBrainz: a "playing now" listen when
 * playback starts and a single listen (with the MusicBrainz recording MBID,
 * looked up once per track and cached) once half the song — max 4 minutes —
 * has actually been listened to.
 */
function ListenBrainzSync() {
	const { currentSong, isPlaying, videoElementRef } = usePlayer();
	const [settings] = useSettings();
	const [meta, setMeta] = useState<TrackMeta | null>(null);

	const songId = currentSong?.id;
	const token = settings.listenbrainzToken.trim();
	const enabled = settings.listenbrainz && token.length > 0;

	const elapsedRef = useRef(0);
	const scrobbledRef = useRef<string | null>(null);
	const startedAtRef = useRef<number | null>(null);
	const playingNowSentRef = useRef(false);
	const playingNowTimerRef = useRef<number | null>(null);
	const isPlayingRef = useRef(isPlaying);

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

	// New track — reset the scrobble state and cancel any pending
	// playing-now submission, so skipping songs doesn't spam MusicBrainz.
	// biome-ignore lint/correctness/useExhaustiveDependencies: songId/enabled are intentional reset triggers
	useEffect(() => {
		elapsedRef.current = 0;
		scrobbledRef.current = null;
		startedAtRef.current = null;
		playingNowSentRef.current = false;
		if (playingNowTimerRef.current !== null) {
			window.clearTimeout(playingNowTimerRef.current);
			playingNowTimerRef.current = null;
		}
	}, [songId, enabled]);

	useEffect(() => {
		isPlayingRef.current = isPlaying;
	}, [isPlaying]);

	useEffect(() => {
		if (!enabled || !songId || !isPlaying || !currentSong) return;
		if (startedAtRef.current === null) {
			startedAtRef.current = Math.floor(Date.now() / 1000);
		}
		if (playingNowSentRef.current) return;
		if (playingNowTimerRef.current !== null) return;
		// Grace period: skipping songs within it cancels the submission.
		playingNowTimerRef.current = window.setTimeout(() => {
			playingNowTimerRef.current = null;
			if (!isPlayingRef.current) return;
			playingNowSentRef.current = true;
			const names = scrobbleMetadataRef.current();
			const videoEl = videoElementRef?.current ?? null;
			const duration =
				videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
			// Resolve the recording MBID for the playing_now listen as well — it
			// links the card and gives it cover art, and pre-warms the cache for
			// the scrobble. Submits without MBIDs if the lookup fails.
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
		}, 5000);
	}, [enabled, songId, isPlaying, currentSong, token, meta, videoElementRef]);

	// Listening-time accumulation + scrobble submission.
	useEffect(() => {
		if (!enabled) return;
		const timer = window.setInterval(() => {
			if (!isPlaying || !currentSong || !songId) return;
			if (scrobbledRef.current === songId) return;
			elapsedRef.current += 1;
			const videoEl = videoElementRef?.current ?? null;
			const duration =
				videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
			// Classic rule: half the track or 4 minutes, whichever first.
			const threshold = Math.max(
				30,
				Math.min(duration > 0 ? duration * 0.5 : 240, 240),
			);
			if (elapsedRef.current < threshold) return;
			scrobbledRef.current = songId;
			const names = scrobbleMetadata();
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
		}, 1000);
		return () => window.clearInterval(timer);
	}, [
		enabled,
		isPlaying,
		currentSong,
		songId,
		token,
		meta,
		scrobbleMetadata,
		videoElementRef,
	]);

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
	const { isNowPlayingOpen, isQueueOpen, setQueueOpen, toggleNowPlaying } =
		usePlayer();

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
	}, [isNowPlayingOpen, isQueueOpen, setQueueOpen, toggleNowPlaying]);

	return (
		<div
			className={cn(
				"fixed inset-0 z-50 transition-[opacity,transform] duration-300 ease-out",
				isNowPlayingOpen
					? "translate-y-0 opacity-100"
					: "pointer-events-none translate-y-6 opacity-0",
			)}
		>
			<NowPlayingPage onClose={toggleNowPlaying} />
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
		if (cookie) {
			setIsLoggedIn(true);
			await getYoutubeClient(cookie);
			const profile = await getUserProfile();
			if (profile) {
				setUserProfile(profile);
			}
		}
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
	const { currentSong, isNowPlayingOpen, isQueueOpen, toggleQueue } =
		usePlayer();

	return (
		<>
			<AmbientSync />
			<DiscordPresenceSync />
			<ListenBrainzSync />
			<div className="h-screen flex bg-background text-foreground overflow-hidden">
				{/* ── Sidebar ─────────────────────────────────── */}
				<aside className="flex w-80 shrink-0 flex-col border-r border-foreground/6 bg-sidebar">
					<div className="flex min-h-0 flex-1 flex-col px-4 pt-8">
						<nav className="space-y-1">
							<SidebarItem
								icon={<HouseIcon className="size-[18px]" strokeWidth={2.2} />}
								isActive={
									location.pathname === "/" || location.pathname === "/home"
								}
								label="Home"
								onClick={() => navigate("/")}
							/>
							<SidebarItem
								icon={<LibraryIcon className="size-[18px]" strokeWidth={2.2} />}
								isActive={location.pathname.startsWith("/playlists")}
								label="Playlists"
								onClick={() => navigate("/playlists")}
							/>
							<SidebarItem
								icon={
									<SettingsIcon className="size-[18px]" strokeWidth={2.2} />
								}
								isActive={location.pathname.startsWith("/settings")}
								label="Settings"
								onClick={() => navigate("/settings")}
							/>
						</nav>

						{/* Pinned playlists */}
						{pinned.length > 0 && (
							<div className="mt-6 min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2 [scrollbar-width:thin]">
								{pinned.map((playlist) => {
									const isActive =
										location.pathname === `/playlists/${playlist.id}`;
									return (
										<div className="group/pin relative" key={playlist.id}>
											<button
												className={cn(
													"flex w-full items-center gap-3 rounded-xl py-2 pr-8 pl-3 text-sm transition-colors duration-200",
													isActive
														? "bg-primary/12 text-primary"
														: "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
												)}
												onClick={() => navigate(`/playlists/${playlist.id}`)}
												type="button"
											>
												{playlist.thumbnail ? (
													<img
														alt=""
														className="size-5 shrink-0 rounded object-cover"
														src={playlist.thumbnail}
													/>
												) : (
													<Music2 className="size-4 shrink-0" />
												)}
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
									);
								})}
							</div>
						)}
					</div>

					<div
						className={cn(
							"border-t border-foreground/6 p-4",
							currentSong && "pb-[104px]",
						)}
					>
						{isLoggedIn ? (
							<UserMenu onLogout={handleLogout} user={userProfile || {}} />
						) : (
							<button
								className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-foreground/[0.05] hover:text-foreground"
								onClick={handleLogin}
								type="button"
							>
								<LogInIcon className="size-5" />
								<span>Log In</span>
							</button>
						)}
					</div>
				</aside>

				{/* ── Main content ────────────────────────────── */}
				<main className="relative flex-1 overflow-hidden">
					<ScrollArea className="h-full">
						<div className="pb-32">
							<div className="animate-page-in" key={location.pathname}>
								<Routes>
									<Route element={<HomePage />} path="/" />
									<Route element={<HomePage />} path="/home" />
									<Route element={<PlaylistsPage />} path="/playlists" />
									<Route element={<PlaylistDetails />} path="/playlists/:id" />
									<Route element={<ArtistPage />} path="/artist/:id" />
									<Route element={<SettingsPage />} path="/settings" />
								</Routes>
							</div>
						</div>
					</ScrollArea>
				</main>

				<NowPlayingOverlay />
				<QueuePanel
					fullscreen={isNowPlayingOpen}
					onClose={() => toggleQueue()}
					open={isQueueOpen}
				/>
				<Player />
			</div>
		</>
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
					: "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
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
