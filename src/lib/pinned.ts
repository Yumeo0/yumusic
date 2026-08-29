import { useEffect, useState } from "react";

const PINNED_KEY = "yumusic:pinned";
const PINNED_EVENT = "yumusic:pinned-changed";

export interface PinnedPlaylist {
	id: string;
	title: string;
	thumbnail: string | null;
}

export function getPinnedPlaylists(): PinnedPlaylist[] {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function savePinnedPlaylists(pinned: PinnedPlaylist[]) {
	try {
		localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
	} catch {
		// best-effort
	}
	window.dispatchEvent(new Event(PINNED_EVENT));
}

/** Shared reactive state for sidebar-pinned playlists. */
export function usePinnedPlaylists() {
	const [pinned, setPinned] = useState<PinnedPlaylist[]>(getPinnedPlaylists);

	useEffect(() => {
		const refresh = () => setPinned(getPinnedPlaylists());
		window.addEventListener(PINNED_EVENT, refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener(PINNED_EVENT, refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);

	return {
		pinned,
		isPinned: (id: string) => pinned.some((p) => p.id === id),
		togglePinned: (playlist: PinnedPlaylist) => {
			const current = getPinnedPlaylists();
			const next = current.some((p) => p.id === playlist.id)
				? current.filter((p) => p.id !== playlist.id)
				: [...current, playlist];
			savePinnedPlaylists(next);
		},
		unpin: (id: string) => {
			savePinnedPlaylists(getPinnedPlaylists().filter((p) => p.id !== id));
		},
	};
}
