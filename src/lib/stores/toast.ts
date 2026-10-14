import { createSignal } from "solid-js";

export interface ToastItem {
	id: number;
	message: string;
}

const [toasts, setToasts] = createSignal<ToastItem[]>([]);
let nextId = 0;

/** Reactive list of active toasts; render with a `<For>`. */
export { toasts };

/** Shows a transient status message (e.g. "Link copied"). */
export function showToast(message: string) {
	const id = ++nextId;
	setToasts((current) => [...current, { id, message }]);
	window.setTimeout(() => {
		setToasts((current) => current.filter((toast) => toast.id !== id));
	}, 2400);
}
