import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { listeningSession } from "@/lib/player/listening";
import { findRecording, submitListen } from "@/lib/services/listenbrainz";
import { useSettings } from "@/lib/stores/settings";
import { formatArtistName, scrobbleTitle } from "@/lib/utils/title";
import { getTrackMeta, type TrackMeta } from "@/lib/youtube/youtube-client";

/**
 * Scrobbles finished plays to ListenBrainz: a "playing now" listen when
 * playback starts and a single listen (with the MusicBrainz recording MBID,
 * looked up once per track and cached) once half the song — max 4 minutes —
 * has actually been listened to.
 */
export function ListenBrainzSync() {
	const { currentSong, videoElementRef } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [settings] = useSettings();
	const [meta, setMeta] = useState<TrackMeta | null>(null);

	const songId = currentSong?.id;
	const token = settings.listenbrainzToken.trim();
	const enabled = settings.listenbrainz && token.length > 0;

	const startedAtRef = useRef<number | null>(null);

	/**
	 * Scrobble metadata in the track's original language: the uploader's
	 * locale-independent title parsed like the display pipeline — always
	 * cleaned, since catalog metadata doesn't follow the display preference —
	 * and the primary artist credit, without channel/group decorations
	 * ("Apricot (Froot)" → "Apricot") so the submission and the MusicBrainz
	 * lookup use the artist's catalog name.
	 */
	const scrobbleMetadata = useCallback((): {
		trackName: string;
		artistName: string;
		mainTitle: string;
		feats: string[];
	} => {
		const { main, feats, trackName } = scrobbleTitle(
			meta?.originalTitle ?? currentSong?.title ?? "",
			currentSong?.artist,
		);
		const artistName = formatArtistName(
			meta?.originalArtist ?? currentSong?.artist ?? "",
		);
		return {
			trackName,
			artistName,
			mainTitle: main,
			feats,
		};
	}, [currentSong, meta]);
	const scrobbleMetadataRef = useRef(scrobbleMetadata);
	scrobbleMetadataRef.current = scrobbleMetadata;

	// Album name for the release metadata.
	useEffect(() => {
		let cancelled = false;
		setMeta(null);
		if (enabled && songId) {
			getTrackMeta(songId).then((next) => {
				if (!cancelled) setMeta(next);
			});
		}
		return () => {
			cancelled = true;
		};
	}, [enabled, songId]);

	// New track — reset the listen-start timestamp so skipping songs doesn't
	// submit a stale listenedAt.
	// biome-ignore lint/correctness/useExhaustiveDependencies: songId/enabled are intentional reset triggers
	useEffect(() => {
		startedAtRef.current = null;
	}, [songId, enabled]);

	// Remember when playback started; used as the scrobble's listenedAt.
	useEffect(() => {
		if (!enabled || !songId || !isPlaying) return;
		if (startedAtRef.current === null) {
			startedAtRef.current = Math.floor(Date.now() / 1000);
		}
	}, [enabled, songId, isPlaying]);

	// The shared listening session drives both the "playing now" submission
	// (grace period reached) and the scrobble (half the track listened), so
	// the timing stays consistent with the YouTube watch-history pings.
	useEffect(() => {
		if (!enabled || !songId || !currentSong) return;
		return listeningSession.subscribe((event, eventSongId) => {
			if (eventSongId !== songId) return;
			const names = scrobbleMetadataRef.current();
			const videoEl = videoElementRef?.current ?? null;
			const duration =
				videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;

			if (event === "established") {
				// Resolve the recording MBID for the playing_now listen as well —
				// it links the card and gives it cover art, and pre-warms the
				// cache for the scrobble. Submits without MBIDs if lookup fails.
				const submit = async () => {
					const mbids = await findRecording(
						names.mainTitle,
						names.artistName,
						duration,
						names.feats,
					).catch(() => null);
					await submitListen({
						token,
						trackName: names.trackName,
						artistName: names.artistName,
						album: meta?.album?.name,
						mbids,
					});
				};
				submit().catch((error) => {
					console.warn("[listenbrainz] playing_now failed:", error);
				});
				return;
			}

			const listenedAt = startedAtRef.current ?? Math.floor(Date.now() / 1000);
			const submit = async () => {
				const mbids = await findRecording(
					names.mainTitle,
					names.artistName,
					duration,
					names.feats,
				).catch(() => null);
				await submitListen({
					token,
					trackName: names.trackName,
					artistName: names.artistName,
					album: meta?.album?.name,
					mbids,
					listenedAt,
				});
			};
			submit().catch((error) => {
				console.warn("[listenbrainz] scrobble failed:", error);
			});
		});
	}, [enabled, songId, currentSong, token, meta, videoElementRef]);

	return null;
}
