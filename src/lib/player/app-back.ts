/** Use the same dismissal path as keyboard Escape, including nested Base UI dialogs. */
export function dismissTopOverlay(): boolean {
	const event = new KeyboardEvent("keydown", {
		key: "Escape",
		code: "Escape",
		bubbles: true,
		cancelable: true,
	});
	(document.activeElement ?? document.body).dispatchEvent(event);
	return event.defaultPrevented;
}

declare global {
	interface Window {
		__yumusicBack?: () => boolean;
	}
}
