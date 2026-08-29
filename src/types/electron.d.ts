declare global {
	interface Window {
		electron: {
			login: () => Promise<string | null>;
			getCookie: () => Promise<string | null>;
			logout: () => Promise<boolean>;
		};
	}
}

export {};
