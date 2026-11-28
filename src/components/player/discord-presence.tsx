import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { useSettings } from "@/lib/stores/settings";
import { loadCoverCrop } from "@/lib/utils/cover-crop";
import { discordArtworkUrl } from "@/lib/utils/discord-artwork";
import { IS_ANDROID, proxiedImageUrl } from "@/lib/utils/tauri";
import { displayTitle, formatArtistName } from "@/lib/utils/title";
import { getArtistAvatar } from "@/lib/youtube/channel-data";

/**
 * Mirrors the current song into Discord rich presence while enabled:
 * cover art + album tooltip (linked), artist avatar, clickable song title and
 * artist, plus playback timestamps that freeze while paused. Paused presence
 * expires after 15 minutes and returns when playback resumes.
 */
export function DiscordPresenceSync() {
	const {
		currentSong,
		currentAlbum,
		activeMedia,
		duration: knownDuration,
	} = usePlayer();
	const { isPlaying } = usePlayerControls();
	const [settings] = useSettings();
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
	const [pauseTimedOut, setPauseTimedOut] = useState(false);
	const discordIdle = pauseTimedOut && !isPlaying;
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

	// Stop retries after the pause timeout. Desktop expiry is enforced in Rust
	// so it also runs while WebView timers are throttled.
	useEffect(() => {
		setPauseTimedOut(false);
		if (!discordEnabled || isPlaying) return;
		const timeout = window.setTimeout(
			() => setPauseTimedOut(true),
			15 * 60_000,
		);
		return () => window.clearTimeout(timeout);
	}, [discordEnabled, isPlaying]);

	useEffect(() => {
		if (!activeMedia) {
			setMediaDuration(0);
			return;
		}
		const sync = () =>
			setMediaDuration(
				activeMedia.readyState > 0 && Number.isFinite(activeMedia.duration)
					? activeMedia.duration
					: 0,
			);
		sync();
		activeMedia.addEventListener("emptied", sync);
		activeMedia.addEventListener("durationchange", sync);
		activeMedia.addEventListener("loadedmetadata", sync);
		return () => {
			activeMedia.removeEventListener("emptied", sync);
			activeMedia.removeEventListener("durationchange", sync);
			activeMedia.removeEventListener("loadedmetadata", sync);
		};
	}, [activeMedia]);

	// The player's metadata length (YouTube's listing) is preferred over the
	// media element's duration, which reports a fraction less; it is also the
	// only total available when a crossfade preload beat the element listeners.
	const durationSecs = knownDuration > 0 ? knownDuration : mediaDuration;

	useEffect(() => {
		if (!discordEnabled || discordIdle || !songId) return;
		const update = () =>
			invoke("set_discord_activity", {
				track: {
					title,
					artist: formatArtistName(artist),
					album: currentAlbum?.name ?? null,
					coverUrl:
						discordCover.source === cover ? discordCover.url || null : null,
					artistAvatarUrl,
					songUrl: `https://music.youtube.com/watch?v=${songId}`,
					artistUrl: artistId
						? `https://music.youtube.com/channel/${artistId}`
						: null,
					albumUrl: currentAlbum?.id
						? `https://music.youtube.com/playlist?list=${currentAlbum.id}`
						: null,
					playing: isPlaying,
					elapsedSecs: activeMedia?.currentTime ?? 0,
					durationSecs,
				},
			}).catch((error) => {
				console.warn("[discord] presence update failed:", error);
			});
		void update();
		activeMedia?.addEventListener("seeked", update);
		const retry = window.setInterval(update, 30_000);
		return () => {
			activeMedia?.removeEventListener("seeked", update);
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
		currentAlbum,
		activeMedia,
	]);

	const shouldClear = !discordEnabled || !songId || (IS_ANDROID && discordIdle);
	useEffect(() => {
		if (shouldClear) {
			invoke("clear_discord_activity").catch((error) => {
				console.warn("[discord] presence clear failed:", error);
			});
		}
	}, [shouldClear]);

	return null;
}
