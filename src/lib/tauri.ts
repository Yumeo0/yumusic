import { invoke } from "@tauri-apps/api/core";

window.electron = {
	login: () => invoke<string | null>("login"),
	getCookie: () => invoke<string | null>("get_cookie"),
	logout: () => invoke<boolean>("logout"),
};

function proxyOrigin(): string {
	const userAgent = navigator.userAgent;
	if (userAgent.includes("Windows") || userAgent.includes("Android")) {
		return "http://proxy.localhost";
	}
	return "proxy://localhost";
}

export const PROXY_ORIGIN = proxyOrigin();
