import { useEffect } from "react";
import { listenRoom } from "@/lib/listen-together/room";
import { startCloudSync } from "@/lib/sync/sync";

export function CloudSync() {
	useEffect(() => {
		const reload = () => listenRoom.reloadSavedSettings();
		const leave = () => listenRoom.leave();
		window.addEventListener("yumusic:sync-account-changed", leave);
		window.addEventListener("yumusic:room-settings-reloaded", reload);
		const stop = startCloudSync();
		return () => {
			stop();
			window.removeEventListener("yumusic:room-settings-reloaded", reload);
			window.removeEventListener("yumusic:sync-account-changed", leave);
		};
	}, []);
	return null;
}
