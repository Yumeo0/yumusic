import { HomeIcon, LibraryIcon, LogInIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { UserMenu } from "./components/user-menu";
import { getUserProfile, getYoutubeClient } from "./lib/youtube-client";
import HomePage from "./pages/home";
import SearchResultsPage from "./pages/search-results";

function App() {
	const [currentView, setCurrentView] = useState<
		"home" | "search" | "playlists"
	>("home");
	const [searchQuery, setSearchQuery] = useState("");
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
				// Initialize client with cookie
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
		// Force reload to clear client state
		window.location.reload();
	};

	const handleSearch = (query: string) => {
		setSearchQuery(query);
		setCurrentView("search");
	};

	const renderContent = () => {
		switch (currentView) {
			case "home":
				return <HomePage onSearch={handleSearch} />;
			case "search":
				if (!searchQuery) {
					return (
						<div className="flex flex-col items-center justify-center h-full text-muted-foreground">
							<SearchIcon className="w-16 h-16 mb-4 opacity-20" />
							<p>Search for songs, artists, or albums</p>
						</div>
					);
				}
				return <SearchResultsPage query={searchQuery} />;
			case "playlists":
				return (
					<div className="flex flex-col items-center justify-center h-full text-muted-foreground">
						<LibraryIcon className="w-16 h-16 mb-4 opacity-20" />
						<p>Playlists coming soon...</p>
					</div>
				);
			default:
				return <HomePage onSearch={handleSearch} />;
		}
	};

	return (
		<div className="h-screen flex bg-background text-foreground overflow-hidden">
			{/* Sidebar */}
			<aside className="w-64 border-r bg-muted/10 flex flex-col shrink-0">
				<div className="p-6">
					<h1 className="text-2xl font-bold flex items-center gap-2">
						<span className="text-primary">Yu</span>Music
					</h1>
				</div>
				<nav className="flex-1 px-4 space-y-2">
					<SidebarItem
						icon={<HomeIcon />}
						isActive={currentView === "home"}
						label="Home"
						onClick={() => setCurrentView("home")}
					/>
					<SidebarItem
						icon={<SearchIcon />}
						isActive={currentView === "search"}
						label="Search"
						onClick={() => setCurrentView("search")}
					/>
					<SidebarItem
						icon={<LibraryIcon />}
						isActive={currentView === "playlists"}
						label="Playlists"
						onClick={() => setCurrentView("playlists")}
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

			{/* Main Content */}
			<main className="flex-1 overflow-auto relative">{renderContent()}</main>
		</div>
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
