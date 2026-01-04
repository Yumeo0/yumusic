/**
 * Validates if a URL is a valid YouTube or YouTube Music URL
 * @param url - The URL to validate
 * @returns true if the URL is a valid YouTube URL, false otherwise
 */
export function isValidYouTubeUrl(url: string): boolean {
	try {
		const patterns = [
			/^(https?:\/\/)?(www\.)?(music\.)?youtube\.com\/.+/,
			/^(https?:\/\/)?(www\.)?youtu\.be\/.+/,
		];
		return patterns.some((pattern) => pattern.test(url));
	} catch {
		return false;
	}
}

/**
 * Extracts the video ID from a YouTube URL
 * @param url - The YouTube URL to extract the video ID from
 * @returns The video ID if found, null otherwise
 */
export function extractVideoId(url: string): string | null {
	try {
		const urlObj = new URL(url);

		// Handle youtu.be short URLs
		if (urlObj.hostname === "youtu.be") {
			return urlObj.pathname.slice(1);
		}

		// Handle standard YouTube and YouTube Music URLs
		if (
			urlObj.hostname.includes("youtube.com") ||
			urlObj.hostname.includes("music.youtube.com")
		) {
			return urlObj.searchParams.get("v");
		}

		return null;
	} catch {
		return null;
	}
}
