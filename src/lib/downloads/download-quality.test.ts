import { expect, test } from "bun:test";
import type { SabrFormat } from "googlevideo/shared-types";
import {
	normalizeDownloadQuality,
	selectDownloadAudioFormat,
} from "./download-quality";

function format(
	itag: number,
	bitrate: number,
	options: Partial<SabrFormat> = {},
): SabrFormat {
	return {
		itag,
		bitrate,
		lastModified: "0",
		mimeType: "audio/webm",
		approxDurationMs: 1000,
		isHdr: false,
		hasAudio: true,
		hasVideo: false,
		hasText: false,
		codecCode: "opus",
		isOriginal: true,
		...options,
	};
}

test("download qualities select the highest available audio within their bitrate target", () => {
	const low = format(249, 72_000, { averageBitrate: 52_000 });
	const medium = format(140, 142_000, { averageBitrate: 125_000 });
	const high = format(251, 208_000, { averageBitrate: 175_000 });
	const original = format(141, 256_000);
	const dubbed = format(250, 300_000, { isOriginal: false });
	const video = format(248, 400_000, { mimeType: "video/webm" });
	const formats = [original, dubbed, low, medium, video, high];

	expect(selectDownloadAudioFormat(formats, "low")).toBe(low);
	expect(selectDownloadAudioFormat(formats, "medium")).toBe(medium);
	expect(selectDownloadAudioFormat(formats, "high")).toBe(high);
	expect(selectDownloadAudioFormat(formats, "original")).toBe(original);
});

test("downloads use the smallest available audio if the target is unavailable", () => {
	const smallest = format(140, 128_000, { isOriginal: false });
	const largest = format(251, 160_000, { isOriginal: false });
	expect(selectDownloadAudioFormat([largest, smallest], "low")).toBe(smallest);
	expect(selectDownloadAudioFormat([largest, smallest], "original")).toBe(
		largest,
	);
	expect(selectDownloadAudioFormat([], "high")).toBeUndefined();
});

test("old or invalid preferences default to Original", () => {
	expect(normalizeDownloadQuality(undefined)).toBe("original");
	expect(normalizeDownloadQuality("unsupported")).toBe("original");
	expect(normalizeDownloadQuality("medium")).toBe("medium");
});
