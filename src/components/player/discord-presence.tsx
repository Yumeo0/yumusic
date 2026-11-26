import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useSettings } from "@/lib/stores/settings";
import { loadCoverCrop } from "@/lib/utils/cover-crop";
import { discordArtworkUrl } from "@/lib/utils/discord-artwork";
import { proxiedImageUrl } from "@/lib/utils/tauri";
import { displayTitle, formatArtistName } from "@/lib/utils/title";
import {
	getArtistAvatar,
	getTrackMeta,
	type TrackMeta,
} from "@/lib/youtube/youtube-client";

/**
 * Mirrors the current song into Discord rich presence while enabled:
 * cover art + album tooltip (linked), artist avatar, clickable song title and
 * artist, plus playback timestamps that freeze while paused. Paused presence
 * expires after 15 minutes and returns when playback resumes.
 */
export function DiscordPresenceSync() {
	const { currentSong, videoElementRef, duration: knownDuration } = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [settings] = useSettings();
	const [meta, setMeta] = useState<TrackMeta | null>(null);
	const [mediaDuration, setMediaDuration] = useState(0);

	const songId = currentSong?.id;
	const artist = currentSong?.artist ?? "";
	const title = displayTitle(
		currentSong?.title ?? "",
		// Uploader videos keep their raw title (no original/translation split).
		currentSong?.upload ? "both" : settings.titleMode,
		settings.cleanTitles,
		artist,
	);
	const cover = currentSong?.thumbnail ?? "";
	const [discordCover, setDiscordCover] = useState({ source: "", url: "" });
	useEffect(() => {
		let cancelled = false;
		if (settings.discordRpc && cover) {
			void loadCoverCrop(proxiedImageUrl(cover, 1024)).then((crop) => {
				if (!cancelled)
					setDiscordCover({
						source: cover,
						url: discordArtworkUrl(cover, crop),
					});
			});
		}
		return () => {
			cancelled = true;
		};
	}, [cover, settings.discordRpc]);
	const artistId =
		currentSong?.artistId ?? currentSong?.artists?.find((a) => a.id)?.id;
	const discordEnabled = settings.discordRpc;
	const [discordIdle, setDiscordIdle] = useState(false);
	const [artistAvatar, setArtistAvatar] = useState<{
		artistId: string;
		url: string;
	} | null>(null);
	const artistAvatarUrl =
		artistAvatar && artistAvatar.artistId === artistId
			? artistAvatar.url
			: null;

	useEffect(() => {
		if (!discordEnabled || !artistId) return;
		let cancelled = false;
		void getArtistAvatar(artistId).then((url) => {
			// Discord fetches the avatar directly and limits image URLs to 300 characters.
			if (!cancelled && url && url.length <= 300 && /^https?:\/\//.test(url)) {
				setArtistAvatar({ artistId, url });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [discordEnabled, artistId]);

	// Metadata refreshes, seeks and the presence retry must not restart this
	// countdown. Only resuming playback or toggling the feature resets it.
	useEffect(() => {
		setDiscordIdle(false);
		if (!discordEnabled || isPlaying) return;
		const timeout = window.setTimeout(() => setDiscordIdle(true), 15 * 60_000);
		return () => window.clearTimeout(timeout);
	}, [discordEnabled, isPlaying]);

	// Track the element's duration reactively: when a song starts, the
	// presence update fires before MSE metadata is parsed (duration NaN),
	// so re-send once durationchange/loadedmetadata deliver the real value.
	// A crossfade preloads the next track onto the idle deck early, so its
	// duration events have already fired by the time the handover makes it
	// current — read the value once at attach time to catch those.
	// biome-ignore lint/correctness/useExhaustiveDependencies: songId is an intentional reset trigger for the tracked duration
	useEffect(() => {
		setMediaDuration(0);
		const videoEl = videoElementRef?.current;
		if (!videoEl) return;
		const sync = () =>
			setMediaDuration(
				Number.isFinite(videoEl.duration) ? videoEl.duration : 0,
			);
		sync();
		videoEl.addEventListener("durationchange", sync);
		videoEl.addEventListener("loadedmetadata", sync);
		return () => {
			videoEl.removeEventListener("durationchange", sync);
			videoEl.removeEventListener("loadedmetadata", sync);
		};
	}, [videoElementRef, songId]);

	// Album data arrives from a follow-up fetch; it upgrades the presence
	// (album tooltip/link) once loaded.
	useEffect(() => {
		let cancelled = false;
		setMeta(null);
		if (discordEnabled && songId) {
			getTrackMeta(songId).then((next) => {
				if (!cancelled) setMeta(next);
			});
		}
		return () => {
			cancelled = true;
		};
	}, [discordEnabled, songId]);

	// The player's metadata length (YouTube's listing) is preferred over the
	// media element's duration, which reports a fraction less; it is also the
	// only total available when a crossfade preload beat the element listeners.
	const durationSecs = knownDuration > 0 ? knownDuration : mediaDuration;

	useEffect(() => {
		if (!discordEnabled || discordIdle || !songId) return;
		const videoEl = videoElementRef?.current ?? null;
		const update = () =>
			invoke("set_discord_activity", {
				track: {
					title,
					artist: formatArtistName(artist),
					album: meta?.album?.name ?? null,
					coverUrl:
						discordCover.source === cover ? discordCover.url || null : null,
					artistAvatarUrl,
					songUrl: `https://music.youtube.com/watch?v=${songId}`,
					artistUrl: artistId
						? `https://music.youtube.com/channel/${artistId}`
						: null,
					albumUrl: meta?.album?.id
						? `https://music.youtube.com/playlist?list=${meta.album.id}`
						: null,
					playing: isPlaying,
					elapsedSecs: videoEl?.currentTime ?? 0,
					durationSecs,
				},
			}).catch((error) => {
				console.warn("[discord] presence update failed:", error);
			});
		void update();
		videoEl?.addEventListener("seeked", update);
		const retry = window.setInterval(update, 30_000);
		return () => {
			videoEl?.removeEventListener("seeked", update);
			window.clearInterval(retry);
		};
	}, [
		discordEnabled,
		discordIdle,
		songId,
		title,
		artist,
		cover,
		discordCover,
		artistId,
		artistAvatarUrl,
		isPlaying,
		durationSecs,
		meta,
		videoElementRef,
	]);

	// Clear expired paused presence as well as disabled or empty playback.
	useEffect(() => {
		if (!discordEnabled || discordIdle || !songId) {
			invoke("clear_discord_activity").catch(() => undefined);
		}
	}, [discordEnabled, discordIdle, songId]);

	return null;
}
