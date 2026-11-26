import { useCallback, useEffect, useRef, useState } from "react";
import { syncDownloadedPlaylist } from "../downloads/downloads";
import type { PlaylistTrack, PlaylistView } from "../music/playlist";
import {
	applySongEnrichment,
	type SongEnrichment,
} from "../music/song-enrichment";
import { reconcilePinnedPlaylists } from "../stores/pinned";
import {
	applyPlaylistChange,
	isFreshPlaylistView,
	patchCachedPlaylistSongs,
	playlistRevision,
	readPlaylistView,
	readWarmPlaylistView,
	subscribeToPlaylistChanges,
	writePlaylistView,
} from "../stores/playlist-cache";
import { showToast } from "../stores/toast";
import { createPlaylistPageMerge, loadPlaylistView } from "./playlist-data";
import {
	hasActivePlaylistTrackEdit,
	removePlaylistTrack,
} from "./playlist-mutations";
import { enrichSongRows } from "./song-description";
import { isAlbumId } from "./youtube.utils";

export function usePlaylistView(
	id: string,
	onDelete: () => void,
	playingId?: string,
) {
	const [playlist, setPlaylist] = useState<PlaylistView | null>(() => {
		const cached = readWarmPlaylistView(id);
		return cached ? forRoute(cached.data, id) : null;
	});
	const [loading, setLoading] = useState(playlist === null);
	const [refreshing, setRefreshing] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const displayed = useRef(playlist);
	const requestRef = useRef<AbortController | null>(null);
	const cancelEnrichment = useRef<(() => void) | null>(null);
	const pendingEnrichment = useRef(new Map<string, SongEnrichment>());
	const flushTimer = useRef<number | null>(null);
	const playing = useRef(playingId);
	playing.current = playingId;

	const publish = useCallback(
		(view: PlaylistView) => {
			const previous = displayed.current;
			displayed.current = view;
			setPlaylist(view);
			if (
				previous?.title !== view.title ||
				previous.thumbnail !== view.thumbnail
			) {
				reconcilePinnedPlaylists([
					{ id, title: view.title, thumbnail: view.thumbnail },
				]);
			}
		},
		[id],
	);

	const flush = useCallback(() => {
		flushTimer.current = null;
		patchCachedPlaylistSongs(id, pendingEnrichment.current);
		pendingEnrichment.current.clear();
	}, [id]);

	const publishLoaded = useCallback(
		(view: PlaylistView) => {
			publish(view);
			syncDownloadedPlaylist(id, view.title, view.songs);
			cancelEnrichment.current?.();
			cancelEnrichment.current = enrichSongRows(
				view.songs,
				(videoId, enrichment) => {
					const current = displayed.current;
					if (!current) return;
					publish({
						...current,
						songs: current.songs.map((song) =>
							song.id === videoId
								? applySongEnrichment(song, enrichment)
								: song,
						),
					});
					const pending = pendingEnrichment.current;
					pending.set(videoId, { ...pending.get(videoId), ...enrichment });
					// Serializing the whole playlist once per enriched row stalls the UI.
					if (flushTimer.current === null)
						flushTimer.current = window.setTimeout(flush, 1500);
				},
				playing.current,
			);
		},
		[flush, id, publish],
	);

	const refresh = useCallback(
		async (force = false) => {
			requestRef.current?.abort();
			cancelEnrichment.current?.();
			if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
			flush();
			setLoadingMore(false);
			setError(null);
			const cached = readWarmPlaylistView(id) ?? readPlaylistView(id);
			if (!force && isFreshPlaylistView(cached)) {
				publishLoaded(forRoute(cached.data, id));
				setLoading(false);
				setRefreshing(false);
				return;
			}

			if (!displayed.current && cached) publish(forRoute(cached.data, id));
			const previous = displayed.current;
			const hasContent = previous !== null;
			setLoading(!hasContent);
			setRefreshing(hasContent);
			const request = new AbortController();
			const { signal } = request;
			requestRef.current = request;
			const revision = playlistRevision(id);
			const hasLocalChanges = () =>
				playlistRevision(id) !== revision || hasActivePlaylistTrackEdit(id);
			const merge = previous && createPlaylistPageMerge(previous.songs);
			let firstPage: PlaylistView | undefined;
			const publishPage = (view: PlaylistView, batch: PlaylistTrack[]) => {
				merge?.append(batch);
				if (merge && !hasLocalChanges()) {
					publish({ ...view, songs: merge.snapshot(view.complete) });
				}
			};
			try {
				const view = await loadPlaylistView(id, {
					signal,
					onFirstPage(first) {
						firstPage = first;
						if (merge) publishPage(first, first.songs);
						else publish(first);
						setLoading(false);
						setLoadingMore(!first.complete);
					},
					onContinuation(batch) {
						const current = displayed.current;
						if (merge && firstPage) publishPage(firstPage, batch);
						else if (current)
							publish({ ...current, songs: [...current.songs, ...batch] });
					},
				});
				if (signal.aborted) return;
				const current = displayed.current;
				if (!view) {
					if (current) {
						showToast("Could not refresh playlist");
						publishLoaded(current);
					} else
						setError(
							isAlbumId(id)
								? "Failed to load album."
								: "Failed to load playlist.",
						);
					return;
				}
				const edited = playlistRevision(id) !== revision;
				// A refresh started before an edit can still return the old playlist.
				if (hasContent && current && hasLocalChanges()) {
					publishLoaded(current);
					return;
				}
				if (hasContent && current && !view.complete) {
					showToast("Could not refresh playlist");
					publishLoaded(current);
					return;
				}
				const next = merge
					? { ...view, songs: merge.snapshot(view.complete) }
					: current && edited
						? { ...current, complete: view.complete }
						: view;
				writePlaylistView(id, next, { keepComplete: true });
				publishLoaded(next);
			} catch (error) {
				if (signal.aborted) return;
				console.error("Error fetching playlist:", error);
				if (displayed.current) {
					showToast("Could not refresh playlist");
					publishLoaded(displayed.current);
				} else setError("Failed to load playlist.");
			} finally {
				if (requestRef.current === request) requestRef.current = null;
				if (!signal.aborted) {
					setLoading(false);
					setRefreshing(false);
					setLoadingMore(false);
				}
			}
		},
		[flush, id, publish, publishLoaded],
	);

	useEffect(() => {
		const unsubscribe = subscribeToPlaylistChanges(id, (change) => {
			if (change.type === "delete") {
				requestRef.current?.abort();
				cancelEnrichment.current?.();
				onDelete();
				return;
			}
			const current = displayed.current;
			if (current) {
				const next = applyPlaylistChange(current, change);
				publish(next);
				if (!readPlaylistView(id)) writePlaylistView(id, next);
			} else void refresh(true);
		});
		void refresh();
		return () => {
			unsubscribe();
			requestRef.current?.abort();
			cancelEnrichment.current?.();
			if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
			flush();
		};
	}, [flush, id, onDelete, publish, refresh]);

	const removeTrack = useCallback(
		async (track: PlaylistTrack, index: number) => {
			const tracks = displayed.current?.songs;
			const currentIndex =
				tracks?.[index] === track
					? index
					: tracks?.findIndex((song) =>
							track.entryId ? song.entryId === track.entryId : song === track,
						);
			if (!tracks || currentIndex === undefined || currentIndex < 0)
				throw new Error("The selected playlist entry changed.");
			const occurrence = tracks
				.slice(0, currentIndex)
				.filter((entry) => entry.id === track.id).length;
			await removePlaylistTrack(id, track, occurrence);
		},
		[id],
	);

	return {
		playlist,
		loading,
		refreshing,
		loadingMore,
		error,
		refresh,
		removeTrack,
	};
}

function forRoute(view: PlaylistView, id: string): PlaylistView {
	return view.id === id ? view : { ...view, id };
}
