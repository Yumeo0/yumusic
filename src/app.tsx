import {
	HouseIcon,
	LibraryIcon,
	LogInIcon,
	Music2,
	SettingsIcon,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { usePinnedPlaylists } from "./lib/pinned";
import { cn } from "./lib/utils";
import { getUserProfile, getYoutubeClient } from "./lib/youtube-client";
import ArtistPage from "./pages/artist";
import HomePage from "./pages/home";
import { NowPlayingPage } from "./pages/now-playing";
import PlaylistsPage, { PlaylistDetails } from "./pages/playlists";
import SettingsPage from "./pages/settings";

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
														crossOrigin="anonymous"
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
