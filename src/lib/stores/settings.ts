import { useEffect, useState } from "react";
import {
	DEFAULT_LYRICS_PROVIDER_ORDER,
	type LyricsProviderId,
	normalizeProviderOrder,
} from "../lyrics/lyrics-providers";

export type TitleMode = "both" | "original" | "translation";

/** Crossfade length bounds, in seconds. */
export const CROSSFADE_MIN_SECONDS = 1;
export const CROSSFADE_MAX_SECONDS = 12;
export const CROSSFADE_DEFAULT_SECONDS = 3;

/** Keeps a stored crossfade length usable even if localStorage was edited. */
export function clampCrossfadeSeconds(value: unknown): number {
	const seconds = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(seconds)) return CROSSFADE_DEFAULT_SECONDS;
	return Math.round(
		Math.min(CROSSFADE_MAX_SECONDS, Math.max(CROSSFADE_MIN_SECONDS, seconds)),
	);
}

export interface Settings {
	romanizeLyrics: boolean;
	discordRpc: boolean;
	titleMode: TitleMode;
	cleanTitles: boolean;
	listenbrainz: boolean;
	listenbrainzToken: string;
	/** Lyrics providers in priority order (highest first). */
	lyricsProviderOrder: LyricsProviderId[];
	/** Prefer a provider that has synced (time-aligned) lyrics. */
	preferSyncedLyrics: boolean;
	/** LRCLIB: also search by title alone when artist+title finds nothing. */
	lrclibLooseMatch: boolean;
	/** Hide the "Today's biggest hits" row from the home feed. */
	hideTodaysBiggestHits: boolean;
	/** Keep playing similar songs when the queue ends. */
	autoplay: boolean;
	/** Fade the end of a song into the start of the next one. */
	crossfade: boolean;
	/** Crossfade overlap length in seconds (clamped to the CROSSFADE_* bounds). */
	crossfadeSeconds: number;
	/**
	 * Playlists kept downloaded: whenever their songs are loaded, tracks that
	 * are not stored yet are queued automatically.
	 */
	downloadedPlaylists: string[];
	/** Report played songs (with progress) to the YouTube watch history. */
	watchHistory: boolean;
	/** Show extra debug/copy actions in song context menus. */
	developerMode: boolean;
}

const SETTINGS_KEY = "yumusic:settings:v1";
const SETTINGS_EVENT = "yumusic:settings-changed";
const DEFAULTS: Settings = {
	romanizeLyrics: true,
	discordRpc: false,
	titleMode: "original",
	cleanTitles: true,
	listenbrainz: false,
	listenbrainzToken: "",
	lyricsProviderOrder: [...DEFAULT_LYRICS_PROVIDER_ORDER],
	preferSyncedLyrics: true,
	lrclibLooseMatch: true,
	hideTodaysBiggestHits: true,
	autoplay: true,
	crossfade: true,
	crossfadeSeconds: CROSSFADE_DEFAULT_SECONDS,
	downloadedPlaylists: [],
	watchHistory: true,
	developerMode: false,
};

export function getSettings(): Settings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...DEFAULTS };
		const parsed = JSON.parse(raw) as Partial<Settings>;
		return {
			...DEFAULTS,
			...parsed,
			lyricsProviderOrder: normalizeProviderOrder(parsed.lyricsProviderOrder),
			crossfadeSeconds: clampCrossfadeSeconds(parsed.crossfadeSeconds),
			downloadedPlaylists: Array.isArray(parsed.downloadedPlaylists)
				? parsed.downloadedPlaylists.filter(
						(id): id is string => typeof id === "string",
					)
				: [],
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export function updateSettings(patch: Partial<Settings>): Settings {
	const next = { ...getSettings(), ...patch };
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
	} catch {
		// best-effort
	}
	window.dispatchEvent(new Event(SETTINGS_EVENT));
	return next;
}

/** Reactive settings bound to localStorage. */
export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
	const [settings, setSettings] = useState<Settings>(getSettings);

	useEffect(() => {
		const refresh = () => setSettings(getSettings());
		window.addEventListener(SETTINGS_EVENT, refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener(SETTINGS_EVENT, refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);

	return [settings, updateSettings];
}
