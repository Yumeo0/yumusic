import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { IS_MOBILE } from "../utils/tauri";

/**
 * Whether the in-app updater can run here. It is a desktop-only plugin: on
 * Android/iOS (and in the plain browser dev server) updates come from the
 * store or the browser, so the UI is hidden there.
 */
export function updaterSupported(): boolean {
	return isTauri() && !IS_MOBILE;
}

/** Checks the configured endpoints for a release newer than this build. */
export async function checkForUpdate(): Promise<Update | null> {
	if (!updaterSupported()) return null;
	return check({ timeout: 30_000 });
}

export interface DownloadProgress {
	downloaded: number;
	total: number | null;
}

/**
 * Downloads and installs an update, reporting byte progress, then relaunches
 * the app into the new build. On Windows the installer may restart the app on
 * its own, in which case the relaunch below never runs.
 */
export async function installUpdate(
	update: Update,
	onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
	let downloaded = 0;
	let total: number | null = null;
	await update.downloadAndInstall((event) => {
		if (event.event === "Started") {
			total = event.data.contentLength ?? null;
		} else if (event.event === "Progress") {
			downloaded += event.data.chunkLength;
		}
		onProgress?.({ downloaded, total });
	});
	await relaunch();
}
