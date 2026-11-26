import { useEffect } from "react";
import { usePlayer } from "@/contexts/player-context";
import { useAmbientColor } from "@/lib/utils/use-ambient-color";

/** Recolors the app accent from the current song's thumbnail. */
export function AmbientSync() {
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
