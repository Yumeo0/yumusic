import type { Song } from "@/contexts/player-context";
import { showToast } from "../stores/toast";
import { IS_MOBILE } from "../utils/tauri";

/**
 * Shares through the native sheet on mobile (Android/iOS). On desktop — and
 * anywhere the platform has no proper sheet — the link is copied to the
 * clipboard instead, so no OS share menu pops up. Dismissing the sheet copies
 * nothing.
 */
export async function shareLink({
	title,
	text,
	url,
	toast = "Link copied to clipboard",
}: {
	title: string;
	text?: string;
	url: string;
	toast?: string;
}) {
	if (IS_MOBILE && typeof navigator.share === "function") {
		try {
			await navigator.share({ title, text, url });
			return;
		} catch (error) {
			if ((error as Error).name === "AbortError") return;
		}
	}
	try {
		await navigator.clipboard.writeText(url);
		showToast(toast);
	} catch {
		showToast("Could not copy link");
	}
}

/** Shares a song's YouTube Music link (native sheet or clipboard). */
export function shareSong(song: Song) {
	return shareLink({
		title: song.title,
		text: `${song.artist} — ${song.title}`,
		url: `https://music.youtube.com/watch?v=${song.id}`,
	});
}
