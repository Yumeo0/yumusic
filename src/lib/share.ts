import { showToast } from "./toast";

/**
 * Opens the native share sheet when the platform provides one (Android), and
 * falls back to copying the link. Dismissing the sheet copies nothing.
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
	if (typeof navigator.share === "function") {
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
