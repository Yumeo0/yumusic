import {
	HouseIcon,
	LibraryIcon,
	LogInIcon,
	Music2,
	Pin,
	SettingsIcon,
	X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	HashRouter,
	Route,
	Routes,
	useLocation,
	useNavigate,
} from "react-router-dom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { installMobileHaptics } from "@/lib/utils/haptics";
import { AmbientSync } from "./components/app/ambient-sync";
import { CloudSync } from "./components/app/cloud-sync";
import { NativeBackNavigation } from "./components/app/native-back-navigation";
import { Titlebar } from "./components/app/titlebar";
import { Toaster } from "./components/app/toaster";
import { UpdateNotifier } from "./components/app/updates";
import { UserMenu } from "./components/app/user-menu";
import { DownloadQueueButton } from "./components/downloads/download-queue";
import { RoomPlaybackBridge } from "./components/listen-together/playback-bridge";
import { RoomActivity } from "./components/listen-together/room-activity";
import { DeviceBridge } from "./components/player/device-bridge";
import { DeviceActivity } from "./components/player/device-picker";
import { DiscordPresenceSync } from "./components/player/discord-presence";
import { ListenBrainzSync } from "./components/player/listenbrainz-sync";
import { MediaSessionSync } from "./components/player/media-session";
import { NowPlayingOverlay } from "./components/player/now-playing-overlay";
import { Player } from "./components/player/player";
import { PlaylistContextMenu } from "./components/playlist/playlist-menu";
import { QueuePanel } from "./components/queue/queue-panel";
import { LinkPreviewDialog } from "./components/song/link-preview-dialog";
import { PlayerProvider } from "./contexts/player-context";
import { hydrateDownloads } from "./lib/downloads/downloads";
import {
	reconcilePinnedPlaylists,
	usePinnedPlaylists,
} from "./lib/stores/pinned";
import {
	pruneStaleCacheVersions,
	readLibraryCache,
} from "./lib/stores/playlist-cache";
import { IS_MOBILE, proxiedImageUrl } from "./lib/utils/tauri";
import { cn } from "./lib/utils/utils";
import { canonicalPlaylistId } from "./lib/youtube/playlist-id";
import { useYouTubeSession } from "./lib/youtube/use-youtube-session";
import HomePage from "./pages/home";

const loadArtist = () => import("./pages/artist");
const loadPlaylists = () => import("./pages/playlists");
const loadSettings = () => import("./pages/settings");
const ArtistPage = lazy(loadArtist);
const ArtistCategoryPage = lazy(() =>
	loadArtist().then(({ ArtistCategoryPage }) => ({
		default: ArtistCategoryPage,
	})),
);
const ListenTogetherPage = lazy(() => import("./pages/listen-together"));
const PlaylistsPage = lazy(loadPlaylists);
const PlaylistDetails = lazy(() =>
	loadPlaylists().then(({ PlaylistDetails }) => ({ default: PlaylistDetails })),
);
const SettingsPage = lazy(loadSettings);

function Layout() {
	const account = useYouTubeSession();
	return (
		<PlayerProvider>
			<AppShell {...account} />
		</PlayerProvider>
	);
}

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
	useEffect(installMobileHaptics, []);
	const location = useLocation();
	const navigate = useNavigate();
	const { pinned, unpin } = usePinnedPlaylists();

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
		const cached = readLibraryCache();
		if (cached && cached.data.length > 0) {
			reconcilePinnedPlaylists(cached.data);
		}
	}, []);

	return (
		<>
			<AmbientSync />
			<CloudSync />
			<DeviceBridge />
			<DeviceActivity />
			<DiscordPresenceSync />
			<ListenBrainzSync />
			<MediaSessionSync />
			<NativeBackNavigation />
			<RoomPlaybackBridge />
			<RoomActivity />
			<UpdateNotifier />
			<Titlebar />
			<div
				className={cn(
					"flex overflow-hidden bg-background text-foreground",
					IS_MOBILE ? "h-app" : "h-[calc(100vh-2.25rem)]",
				)}
			>
				<aside className="hidden w-70 shrink-0 flex-col border-r border-foreground/6 bg-sidebar md:flex">
					<div
						className={cn("flex min-h-0 flex-1 flex-col px-4 pt-6", "pb-26")}
					>
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
							<NavigationItems />
						</nav>

						{pinned.length > 0 && (
							<div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-foreground/6 pt-3">
								<div className="flex items-center gap-2 px-3 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
									<Pin className="size-3" />
									<span>Pinned</span>
								</div>
								<div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2 scrollbar-thin">
									{pinned.map((playlist) => {
										const isActive =
											location.pathname.startsWith("/playlists/") &&
											canonicalPlaylistId(
												location.pathname.slice("/playlists/".length),
											) === playlist.id;
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
														className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 transition-all duration-150 hover:bg-foreground/10 hover:text-foreground group-hover/pin:opacity-100 group-focus-within/pin:opacity-100"
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

						<div className="mt-auto pt-3 pb-4">
							<div className="border-t border-foreground/6 pt-3">
								<DownloadQueueButton />
							</div>
						</div>
					</div>
				</aside>

				<main className="relative flex-1 overflow-hidden">
					<ScrollArea className="h-full">
						{/* Extra top/bottom room on mobile: status-bar safe area,
						    plus nav bar + player clearance */}
						<div className="max-md:pt-(--safe-area-top) pb-44 md:pb-32">
							<Suspense fallback={<RouteLoading />} key={location.pathname}>
								<div className="animate-page-in">
									<Routes>
										<Route element={<HomePage />} path="/" />
										<Route element={<HomePage />} path="/home" />
										<Route element={<ListenTogetherPage />} path="/listen" />
										<Route element={<PlaylistsPage />} path="/playlists" />
										<Route
											element={<PlaylistDetails />}
											path="/playlists/:id"
										/>
										<Route element={<ArtistPage />} path="/artist/:id" />
										<Route
											element={<ArtistCategoryPage />}
											path="/artist/:id/category/:category"
										/>
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
							</Suspense>
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

function RouteLoading() {
	return (
		<p className="px-6 py-8 text-sm text-muted-foreground" role="status">
			Loading…
		</p>
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
const destinations = [
	{
		path: "/",
		label: "Home",
		icon: HouseIcon,
		matches: (path: string) => path === "/" || path === "/home",
	},
	{
		path: "/playlists",
		label: "Playlists",
		icon: LibraryIcon,
		load: loadPlaylists,
		matches: (path: string, mobile: boolean) =>
			mobile ? path.startsWith("/playlists") : path === "/playlists",
	},
	{
		path: "/settings",
		label: "Settings",
		icon: SettingsIcon,
		load: loadSettings,
		matches: (path: string) => path.startsWith("/settings"),
	},
];

function MobileNav() {
	return (
		<nav
			className="fixed inset-x-0 bottom-0 z-45 flex min-h-[calc(3.75rem+var(--safe-area-bottom))] items-stretch border-t border-foreground/8 bg-sidebar/95 pb-(--safe-area-bottom) backdrop-blur-xl md:hidden"
			data-mobile-nav
		>
			<NavigationItems mobile />
		</nav>
	);
}

function NavigationItems({ mobile = false }: { mobile?: boolean }) {
	const { pathname } = useLocation();
	const navigate = useNavigate();
	return destinations.map(({ path, label, icon: Icon, load, matches }) => {
		const active = matches(pathname, mobile);
		const preload = load && (() => void load().catch(() => undefined));
		return (
			<button
				aria-current={active ? "page" : undefined}
				className={cn(
					mobile
						? "flex flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors duration-200 active:scale-95"
						: "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200",
					active
						? mobile
							? "text-primary"
							: "bg-primary/12 text-primary"
						: mobile
							? "text-muted-foreground"
							: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
				)}
				key={path}
				onClick={() => navigate(path)}
				onFocus={preload}
				onPointerEnter={preload}
				type="button"
			>
				<Icon className={mobile ? "size-5" : "size-4.5"} strokeWidth={2.2} />
				<span>{label}</span>
			</button>
		);
	});
}

function App() {
	return (
		<HashRouter>
			<Layout />
		</HashRouter>
	);
}

const root = createRoot(document.body);
root.render(
	<div style={{ isolation: "isolate" }}>
		<App />
	</div>,
);
