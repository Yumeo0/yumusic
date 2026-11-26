import { useEffect } from "react";
import { listenRoom } from "@/lib/listen-together/room";
import {
	ROOM_SETTINGS_RELOADED,
	SYNC_ACCOUNT_CHANGED,
} from "@/lib/sync/events";
import { startCloudSync } from "@/lib/sync/sync";

export function CloudSync() {
	useEffect(() => {
		const reload = () => listenRoom.reloadSavedSettings();
		const leave = () => listenRoom.leave();
		window.addEventListener(SYNC_ACCOUNT_CHANGED, leave);
		window.addEventListener(ROOM_SETTINGS_RELOADED, reload);
		const stop = startCloudSync();
		return () => {
			stop();
			window.removeEventListener(ROOM_SETTINGS_RELOADED, reload);
			window.removeEventListener(SYNC_ACCOUNT_CHANGED, leave);
		};
	}, []);
	return null;
}
