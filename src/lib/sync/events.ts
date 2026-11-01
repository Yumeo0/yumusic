/** Store writes use this event; importing it never starts a network client. */
export const SYNC_DATA_CHANGED = "yumusic:sync-data-changed";
export function notifySyncChange() {
	if (typeof window !== "undefined")
		window.dispatchEvent(new Event(SYNC_DATA_CHANGED));
}
