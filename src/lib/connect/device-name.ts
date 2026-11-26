import { isTauri } from "@tauri-apps/api/core";
import { IS_ANDROID } from "@/lib/utils/tauri";

const DEVICE_NAME_KEY = "yumusic:device-name:v1";
export const MAX_DEVICE_NAME_LENGTH = 80;

export function localDeviceKind() {
	if (IS_ANDROID) return "phone";
	return isTauri() ? "desktop" : "browser";
}

function defaultDeviceName() {
	switch (localDeviceKind()) {
		case "phone":
			return "Android phone";
		case "desktop":
			return /Windows/.test(navigator.userAgent) ? "Windows PC" : "Desktop";
		case "browser":
			return "Web browser";
	}
}

function normalizeDeviceName(name: string) {
	return name.trim().slice(0, MAX_DEVICE_NAME_LENGTH);
}

export function readDeviceName() {
	return (
		normalizeDeviceName(localStorage.getItem(DEVICE_NAME_KEY) ?? "") ||
		defaultDeviceName()
	);
}

export function saveDeviceName(name: string) {
	localStorage.setItem(DEVICE_NAME_KEY, normalizeDeviceName(name));
}
