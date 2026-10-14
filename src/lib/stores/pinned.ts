import { createStore } from "solid-js";

const PINNED_KEY = "yumusic:pinned";

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

/** Shared reactive list of sidebar-pinned playlists. */
const [pinnedStore, setPinnedStore] = createStore<{ list: PinnedPlaylist[] }>({
	list: getPinnedPlaylists(),
});

function savePinnedPlaylists(pinned: PinnedPlaylist[]) {
	try {
		localStorage.setItem(PINNED_KEY, JSON.stringify(pinned));
	} catch {
		// best-effort
	}
	setPinnedStore((state) => {
		state.list = pinned;
	});
}

if (typeof window !== "undefined") {
	// Another window changed the pins: fold the stored values in.
	window.addEventListener("storage", () => {
		savePinnedPlaylists(getPinnedPlaylists());
	});
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
	const fresh = new Map(items.map((item) => [item.id, item]));
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

/**
 * Reactive pinned playlists for the sidebar. Keep the returned object and
 * read `pinned` where it renders (destructuring `pinned` would capture a
 * snapshot); the action functions are stable and safe to destructure.
 */
export function usePinnedPlaylists() {
	return {
		get pinned() {
			return pinnedStore.list;
		},
		isPinned: (id: string) => pinnedStore.list.some((p) => p.id === id),
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
