import { HomeIcon, LibraryIcon, LogInIcon } from "lucide-react";
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
import { UserMenu } from "./components/user-menu";
import { PlayerProvider, usePlayer } from "./contexts/player-context";
import { getUserProfile, getYoutubeClient } from "./lib/youtube-client";
import HomePage from "./pages/home";
import { NowPlayingPage } from "./pages/now-playing";
import PlaylistsPage, { PlaylistDetails } from "./pages/playlists";

function NowPlayingOverlay() {
	const { isNowPlayingOpen, toggleNowPlaying } = usePlayer();

	return (
		<div
			className="fixed inset-0 z-40 bg-background"
			style={{
				opacity: isNowPlayingOpen ? 1 : 0,
				pointerEvents: isNowPlayingOpen ? "auto" : "none",
			}}
		>
			<NowPlayingPage onClose={toggleNowPlaying} />
		</div>
	);
}

function Layout() {
	const location = useLocation();
	const navigate = useNavigate();
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
			<div className="h-screen flex bg-background text-foreground overflow-hidden">
				<aside className="w-64 border-r bg-muted/10 flex flex-col shrink-0">
					<div className="p-6">
						<h1 className="text-2xl font-bold flex items-center gap-2">
							YuMusic
						</h1>
					</div>
					<nav className="flex-1 px-4 space-y-2">
						<SidebarItem
							icon={<HomeIcon />}
							isActive={
								location.pathname === "/" || location.pathname === "/home"
							}
							label="Home"
							onClick={() => navigate("/")}
						/>
						<SidebarItem
							icon={<LibraryIcon />}
							isActive={location.pathname.startsWith("/playlists")}
							label="Playlists"
							onClick={() => navigate("/playlists")}
						/>
					</nav>

					<div className="p-4 border-t mt-auto">
						{isLoggedIn ? (
							<UserMenu onLogout={handleLogout} user={userProfile || {}} />
						) : (
							<button
								className="w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-sm font-medium hover:bg-muted text-muted-foreground hover:text-foreground"
								onClick={handleLogin}
								type="button"
							>
								<LogInIcon className="w-5 h-5" />
								<span>Log In</span>
							</button>
						)}
					</div>
				</aside>

				<main className="flex-1 overflow-hidden relative">
					<ScrollArea className="h-full">
						<div className="pb-24">
							<Routes>
								<Route element={<HomePage />} path="/" />
								<Route element={<HomePage />} path="/home" />
								<Route element={<PlaylistsPage />} path="/playlists" />
								<Route element={<PlaylistDetails />} path="/playlists/:id" />
							</Routes>
						</div>
					</ScrollArea>
				</main>
				<NowPlayingOverlay />
				<Player />
			</div>
		</PlayerProvider>
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
			className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-colors text-sm font-medium ${
				isActive
					? "bg-primary/10 text-primary"
					: "hover:bg-muted text-muted-foreground hover:text-foreground"
			}`}
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
