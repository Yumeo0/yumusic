import { useEffect, useState } from "react";

const PINNED_KEY = "yumusic:pinned";
const PINNED_EVENT = "yumusic:pinned-changed";

export interface PinnedPlaylist {
	id: string;
	title: string;
	thumbnail: string | null;
}

/** YouTube browse ids add VL to the same id used by playlist share links. */
export const canonicalPlaylistId = (id: string) =>
	id.startsWith("VL") ? id.slice(2) : id;

export function getPinnedPlaylists(): PinnedPlaylist[] {
	try {
		const raw = localStorage.getItem(PINNED_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const unique = new Map<string, PinnedPlaylist>();
		for (const item of parsed) {
			if (!item || typeof item.id !== "string") continue;
			const id = canonicalPlaylistId(item.id);
			const previous = unique.get(id);
			unique.set(id, {
				...item,
				id,
				thumbnail: item.thumbnail || previous?.thumbnail || null,
			});
		}
		const pinned = [...unique.values()];
		// Migrate old aliases and duplicate pins on read, including synced
		// lists. No event here: reads also happen while React is rendering.
		const normalized = JSON.stringify(pinned);
		if (normalized !== raw) {
			try {
				localStorage.setItem(PINNED_KEY, normalized);
			} catch {
				// Still return the normalized list when storage is full.
			}
		}
		return pinned;
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

export function togglePinnedPlaylist(playlist: PinnedPlaylist) {
	const id = canonicalPlaylistId(playlist.id);
	const current = getPinnedPlaylists();
	const next = current.some((p) => p.id === id)
		? current.filter((p) => p.id !== id)
		: [...current, { ...playlist, id }];
	savePinnedPlaylists(next);
}

/**
 * Updates stored titles and thumbnails of pinned playlists that appear (with
 * different values) in a freshly loaded list — e.g. a system playlist whose
 * name was previously captured in another locale, or a cover URL that has
 * since changed or died. Older app versions persisted the raw tiny variant
 * (e.g. `=s192`), whose token may no longer resolve on the CDN.
 *
 * Thumbnails are only replaced when the fresh list provides one, so a failed
 * lookup never strips artwork that might still load.
 */
export function reconcilePinnedPlaylists(
	items: Array<{ id: string; title: string; thumbnail?: string | null }>,
) {
	const fresh = new Map(
		items.map((item) => [canonicalPlaylistId(item.id), item]),
	);
	const current = getPinnedPlaylists();
	let changed = false;
	const next = current.map((pinned) => {
		const item = fresh.get(pinned.id);
		if (!item) return pinned;
		const title =
			item.title && item.title !== pinned.title ? item.title : pinned.title;
		const thumbnail =
			item.thumbnail && item.thumbnail !== pinned.thumbnail
				? item.thumbnail
				: pinned.thumbnail;
		if (title === pinned.title && thumbnail === pinned.thumbnail) return pinned;
		changed = true;
		return { ...pinned, title, thumbnail };
	});
	if (changed) savePinnedPlaylists(next);
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
		isPinned: (id: string) =>
			pinned.some((p) => p.id === canonicalPlaylistId(id)),
		togglePinned: togglePinnedPlaylist,
		unpin: (id: string) => {
			savePinnedPlaylists(
				getPinnedPlaylists().filter((p) => p.id !== canonicalPlaylistId(id)),
			);
		},
	};
}
