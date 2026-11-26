import type { SabrFormat } from "googlevideo/shared-types";

export const DOWNLOAD_QUALITY_LABELS = {
	low: "Low",
	medium: "Medium",
	high: "High",
	original: "Original",
} as const;

export type DownloadQuality = keyof typeof DOWNLOAD_QUALITY_LABELS;

export const DEFAULT_DOWNLOAD_QUALITY: DownloadQuality = "original";

export function normalizeDownloadQuality(value: unknown): DownloadQuality {
	return typeof value === "string" &&
		Object.hasOwn(DOWNLOAD_QUALITY_LABELS, value)
		? (value as DownloadQuality)
		: DEFAULT_DOWNLOAD_QUALITY;
}

export const DOWNLOAD_QUALITY_TARGET_BITRATES = {
	low: 64_000,
	medium: 128_000,
	high: 192_000,
} as const;

function bitrateOf(format: SabrFormat): number {
	const average = format.averageBitrate ?? 0;
	if (Number.isFinite(average) && average > 0) return average;
	return Number.isFinite(format.bitrate) && format.bitrate > 0
		? format.bitrate
		: 0;
}

/** Selects an available rendition of the original audio track when possible. */
export function selectDownloadAudioFormat(
	formats: readonly SabrFormat[],
	quality: DownloadQuality,
): SabrFormat | undefined {
	const audio = formats.filter((format) =>
		format.mimeType?.startsWith("audio/"),
	);
	const original = audio.filter((format) => format.isOriginal);
	const ranked = (original.length ? original : audio).sort(
		(a, b) => bitrateOf(a) - bitrateOf(b),
	);
	if (quality === "original") return ranked.at(-1);

	const target = DOWNLOAD_QUALITY_TARGET_BITRATES[quality];
	return (
		ranked.findLast((format) => {
			const bitrate = bitrateOf(format);
			return bitrate > 0 && bitrate <= target;
		}) ??
		ranked.find((format) => bitrateOf(format) > 0) ??
		ranked[0]
	);
}
