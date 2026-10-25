/** Full output supported by HTMLMediaElement.volume. */
export const MAX_VOLUME = 1;

/** Keep the previous starting loudness when no saved volume exists. */
export const DEFAULT_VOLUME = 0.15;

/** Give quiet levels more slider travel; halfway is 12.5% output. */
export function linearToVolume(linear: number): number {
	return Math.min(1, Math.max(0, linear)) ** 3 * MAX_VOLUME;
}

/** Restore slider position without changing the persisted output level. */
export function volumeToLinear(volume: number): number {
	return Math.cbrt(Math.min(MAX_VOLUME, Math.max(0, volume)) / MAX_VOLUME);
}
