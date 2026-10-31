declare global {
	interface Window {
		readonly __YUMUSIC_SELF_UPDATE_SUPPORTED__?: boolean;
		electron: {
			login: () => Promise<string | null>;
			getCookie: () => Promise<string | null>;
			validateSession: () => Promise<string | null>;
			logout: () => Promise<boolean>;
		};
	}
}

export {};
