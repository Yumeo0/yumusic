import { createContext, type ReactNode, useContext, useState } from "react";
import { getSongStream } from "@/lib/youtube-client";

export interface Song {
	id: string;
	title: string;
	artist: string;
	thumbnail: string;
	duration?: string;
}

interface PlayerContextType {
	currentSong: Song | null;
	isPlaying: boolean;
	play: (song: Song) => void;
	pause: () => void;
	resume: () => void;
	toggle: () => void;
	streamUrl: string | null;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [currentSong, setCurrentSong] = useState<Song | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [streamUrl, setStreamUrl] = useState<string | null>(null);

	const play = async (song: Song) => {
		if (currentSong?.id === song.id) {
			setIsPlaying(true);
			return;
		}

		setIsPlaying(false);
		setCurrentSong(song);
		setStreamUrl(null);

		try {
			const url = await getSongStream(song.id);
			if (url) {
				setStreamUrl(url);
				setIsPlaying(true);
			}
		} catch (error) {
			console.error("Failed to play song:", error);
		}
	};

	const pause = () => setIsPlaying(false);
	const resume = () => setIsPlaying(true);
	const toggle = () => setIsPlaying(!isPlaying);

	return (
		<PlayerContext.Provider
			value={{
				currentSong,
				isPlaying,
				play,
				pause,
				resume,
				toggle,
				streamUrl,
			}}
		>
			{children}
		</PlayerContext.Provider>
	);
}

export function usePlayer() {
	const context = useContext(PlayerContext);
	if (context === undefined) {
		throw new Error("usePlayer must be used within a PlayerProvider");
	}
	return context;
}
