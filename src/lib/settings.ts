import { useEffect, useState } from "react";

export interface Settings {
	romanizeLyrics: boolean;
	discordRpc: boolean;
}

const SETTINGS_KEY = "yumusic:settings:v1";
const SETTINGS_EVENT = "yumusic:settings-changed";
const DEFAULTS: Settings = {
	romanizeLyrics: false,
	discordRpc: false,
};

export function getSettings(): Settings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
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
