import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryPlaylist } from "../music/playlist";
import {
	readLibraryCache,
	subscribeToLibraryChanges,
} from "../stores/playlist-cache";
import { loadPlaylistLibrary } from "./playlist-library";

export function usePlaylistLibrary(active = true) {
	const [playlists, setPlaylists] = useState<LibraryPlaylist[] | null>(null);
	const [loading, setLoading] = useState(active);
	const [failed, setFailed] = useState(false);
	const requestRef = useRef(0);

	const refresh = useCallback(async (force = false) => {
		const request = ++requestRef.current;
		setLoading(true);
		setFailed(false);
		try {
			const entries = await loadPlaylistLibrary(force);
			if (request === requestRef.current) setPlaylists(entries);
		} catch (error) {
			if (request !== requestRef.current) return;
			console.error("Error fetching playlists:", error);
			setFailed(true);
		} finally {
			if (request === requestRef.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!active) return;
		void refresh();
		const unsubscribe = subscribeToLibraryChanges(() => {
			const cached = readLibraryCache();
			if (cached) {
				requestRef.current++;
				setPlaylists(cached.data);
				setLoading(false);
				setFailed(false);
			} else void refresh();
		});
		return () => {
			requestRef.current++;
			unsubscribe();
		};
	}, [active, refresh]);

	return { playlists, loading, failed, refresh };
}
