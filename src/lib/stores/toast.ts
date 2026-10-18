export interface ToastItem {
	id: number;
	message: string;
	/** Makes the whole toast clickable, e.g. to run what it announces. */
	onClick?: () => void;
}

export interface ToastOptions {
	onClick?: () => void;
	/** Auto-dismiss delay in ms; null keeps the toast until it is dismissed. */
	durationMs?: number | null;
}

interface ToastPatch {
	message?: string;
	onClick?: () => void;
	durationMs?: number | null;
}

type Listener = (toasts: ToastItem[]) => void;

const DEFAULT_DURATION_MS = 2400;

const listeners = new Set<Listener>();
const timers = new Map<number, number>();
let toasts: ToastItem[] = [];
let nextId = 0;

function emit() {
	for (const listener of listeners) listener(toasts);
}

function clearTimer(id: number) {
	const timer = timers.get(id);
	if (timer === undefined) return;
	window.clearTimeout(timer);
	timers.delete(id);
}

function scheduleDismiss(id: number, durationMs: number | null) {
	clearTimer(id);
	if (durationMs === null) return;
	timers.set(
		id,
		window.setTimeout(() => dismissToast(id), durationMs),
	);
}

/** Removes a toast ahead of its auto-dismiss delay. */
export function dismissToast(id: number) {
	clearTimer(id);
	toasts = toasts.filter((toast) => toast.id !== id);
	emit();
}

/** Shows a transient status message (e.g. "Link copied"). */
export function showToast(
	message: string,
	{ onClick, durationMs = DEFAULT_DURATION_MS }: ToastOptions = {},
): number {
	const id = ++nextId;
	toasts = [...toasts, { id, message, onClick }];
	emit();
	scheduleDismiss(id, durationMs);
	return id;
}

/**
 * Rewrites a toast that is already on screen, e.g. to turn an announcement
 * into progress once the announced action has started.
 */
export function updateToast(id: number, patch: ToastPatch) {
	if (!toasts.some((toast) => toast.id === id)) return;
	const { durationMs, ...item } = patch;
	toasts = toasts.map((toast) =>
		toast.id === id ? { ...toast, ...item } : toast,
	);
	emit();
	if (durationMs !== undefined) scheduleDismiss(id, durationMs);
}

export function subscribeToasts(listener: Listener): () => void {
	listeners.add(listener);
	listener(toasts);
	return () => {
		listeners.delete(listener);
	};
}
