import { useCallback } from "react";
import { useSettings } from "../stores/settings";
import { displayTitle, formatTitleParts, type TitleCredit } from "./title";

/**
 * Settings-bound title formatter for plain-string display sites. `keepTitle`
 * is for uploader videos, whose raw "Original - Translation"-shaped title is
 * shown whole — the title mode doesn't apply to them.
 */
export function useDisplayTitle(): (
	title: string,
	keepTitle?: boolean,
) => string {
	const [settings] = useSettings();
	return useCallback(
		(title: string, keepTitle = false) =>
			displayTitle(
				title,
				keepTitle ? "both" : settings.titleMode,
				settings.cleanTitles,
			),
		[settings.cleanTitles, settings.titleMode],
	);
}

/**
 * Settings-bound variant that keeps feats and credits separate; `keepTitle`
 * behaves as in `useDisplayTitle`.
 */
export function useFormatTitle(): (
	title: string,
	artist?: string,
	keepTitle?: boolean,
) => {
	main: string;
	feats: string[];
	credits: TitleCredit[];
	coverArtists: string[];
} {
	const [settings] = useSettings();
	return useCallback(
		(title: string, artist?: string, keepTitle = false) =>
			formatTitleParts(
				title,
				keepTitle ? "both" : settings.titleMode,
				settings.cleanTitles,
				artist,
			),
		[settings.cleanTitles, settings.titleMode],
	);
}
