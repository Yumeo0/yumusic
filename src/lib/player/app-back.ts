export interface BackActions {
	dismissOverlay: () => boolean;
	closeQueue: () => boolean;
	closePlayer: () => boolean;
	navigateBack: () => boolean;
}

/** Consume exactly one visible layer before considering navigation or exit. */
export function handleAppBack(actions: BackActions): boolean {
	return (
		actions.dismissOverlay() ||
		actions.closeQueue() ||
		actions.closePlayer() ||
		actions.navigateBack()
	);
}

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
