import type { YTMusic } from "youtubei.js/web";
import type { SearchResult } from "../preload";

declare global {
	interface Window {
		electron: {
			login: () => Promise<string | null>;
			getCookie: () => Promise<string | null>;
			logout: () => Promise<boolean>;
		};
		youtube: {
			validateURL: (url: string) => Promise<boolean>;
			getInfo: (url: string) => Promise<{
				success: boolean;
				data?: YTMusic.TrackInfo;
				error?: string;
			}>;
			search: (
				query: string,
			) => Promise<{ success: boolean; data?: SearchResult[]; error?: string }>;
		};
	}
}
