import type { CoverCrop } from "./cover-crop";

/** Discord fetches HTTP artwork itself, so CSS cropping cannot affect it. */
export function discordArtworkUrl(
	source: string,
	crop: CoverCrop | null,
): string {
	if (!crop || !/^https?:\/\//.test(source)) return source;
	const url = new URL("https://wsrv.nl/");
	url.search = new URLSearchParams({
		url: source,
		cy: `${crop.top * 100}%`,
		ch: `${(1 - crop.top - crop.bottom) * 100}%`,
		cw: "100%",
		precrop: "",
		w: "512",
		h: "512",
		fit: "cover",
		output: "jpg",
	}).toString();
	return url.toString();
}
