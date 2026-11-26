import { useEffect } from "react";
import { usePlayer } from "@/contexts/player-context";
import { listeningSession } from "@/lib/player/listening";
import { findRecording, submitListen } from "@/lib/services/listenbrainz";
import { useSettings } from "@/lib/stores/settings";
import { formatArtistName, scrobbleTitle } from "@/lib/utils/title";

export function ListenBrainzSync() {
	const { currentSong, currentTrackMeta, activeMedia, duration } = usePlayer();
	const [settings] = useSettings();
	const token = settings.listenbrainzToken.trim();
	const enabled = settings.listenbrainz && token.length > 0;

	useEffect(() => {
		if (!enabled || !currentSong) return;
		const title = scrobbleTitle(
			currentTrackMeta?.originalTitle ?? currentSong.title,
			currentSong.artist,
		);
		const artistName = formatArtistName(
			currentTrackMeta?.originalArtist ?? currentSong.artist,
		);
		return listeningSession.subscribe((event, songId, startedAt) => {
			if (songId !== currentSong.id) return;
			const mediaDuration = activeMedia?.duration;
			const recordingDuration =
				mediaDuration && Number.isFinite(mediaDuration)
					? mediaDuration
					: duration;
			void findRecording(title.main, artistName, recordingDuration, title.feats)
				// The MBID improves matching and cover art. A lookup failure still counts as a listen.
				.catch(() => null)
				.then((mbids) =>
					submitListen({
						token,
						trackName: title.trackName,
						artistName,
						album: currentTrackMeta?.album?.name,
						mbids,
						listenedAt: event === "scrobbled" ? startedAt : undefined,
					}),
				)
				.catch((error) =>
					console.warn("[listenbrainz] Submission failed:", error),
				);
		});
	}, [enabled, currentSong, currentTrackMeta, activeMedia, duration, token]);

	return null;
}
