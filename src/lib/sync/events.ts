/** Store writes use this event; importing it never starts a network client. */
export const SYNC_DATA_CHANGED = "yumusic:sync-data-changed";
export const SYNC_ACCOUNT_CHANGED = "yumusic:sync-account-changed";
export const ROOM_SETTINGS_RELOADED = "yumusic:room-settings-reloaded";

export function notifySyncChange() {
	if (typeof window !== "undefined")
		window.dispatchEvent(new Event(SYNC_DATA_CHANGED));
}
