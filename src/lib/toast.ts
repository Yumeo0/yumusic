export interface ToastItem {
	id: number;
	message: string;
}

type Listener = (toasts: ToastItem[]) => void;

const listeners = new Set<Listener>();
let toasts: ToastItem[] = [];
let nextId = 0;

function emit() {
	for (const listener of listeners) listener(toasts);
}

/** Shows a transient status message (e.g. "Link copied"). */
export function showToast(message: string) {
	const id = ++nextId;
	toasts = [...toasts, { id, message }];
	emit();
	window.setTimeout(() => {
		toasts = toasts.filter((toast) => toast.id !== id);
		emit();
	}, 2400);
}

export function subscribeToasts(listener: Listener): () => void {
	listeners.add(listener);
	listener(toasts);
	return () => {
		listeners.delete(listener);
	};
}
