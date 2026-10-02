import { useSyncExternalStore } from "react";

/**
 * Tiny external store for player *UI* flags (fullscreen open, queue sheet
 * open). These live outside PlayerProvider on purpose: keeping them in the
 * React context meant every open/close re-rendered the provider's value,
 * which re-rendered the entire app shell and current page before the
 * open/close animation could start (a ~0.5s hitch). Here only the few
 * components that actually read these flags re-render.
 */
let nowPlayingOpen = false;
/**
 * Queue sheet position. On mobile the queue can rest halfway up (a quick peek
 * that is easy to swipe closed); on desktop anything but "closed" renders as
 * the open drawer.
 */
export type QueueState = "closed" | "half" | "full";
let queueState: QueueState = "closed";

const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getNowPlayingOpen() {
	return nowPlayingOpen;
}

export function setNowPlayingOpen(open: boolean) {
	if (nowPlayingOpen === open) return;
	nowPlayingOpen = open;
	emit();
}

export function toggleNowPlaying() {
	setNowPlayingOpen(!nowPlayingOpen);
}

/** Closes the fullscreen player if open; safe to call unconditionally. */
export function closeNowPlaying() {
	setNowPlayingOpen(false);
}

export function getQueueState() {
	return queueState;
}

/**
 * Blend factor (0 = closed layout, 1 = queue-up layout) for fullscreen views
 * that morph while the queue is dragged. Written per frame by the drag
 * gestures, so it must not re-render React. It is applied to the morphing
 * stage element rather than the document root: a custom property on the root
 * invalidates the computed style of every element in the app, which makes
 * drags stutter once the queue list is populated.
 */
let queueReveal = 0;
let queueRevealTarget: HTMLElement | null = null;

/**
 * Points the blend writes at the element whose subtree uses the variable
 * (the now-playing morph stage). Pass null on unmount; the current value is
 * re-applied when a new target registers, so toggling mobile lyrics mode (and
 * remounting the stage) picks the blend back up.
 */
export function setQueueRevealTarget(target: HTMLElement | null) {
	queueRevealTarget = target;
	applyQueueReveal();
}

export function getQueueReveal() {
	return queueReveal;
}

export function setQueueReveal(reveal: number) {
	queueReveal = Math.min(Math.max(reveal, 0), 1);
	applyQueueReveal();
}

function applyQueueReveal() {
	if (typeof document === "undefined") return;
	const target = queueRevealTarget ?? document.documentElement;
	target.style.setProperty("--queue-reveal", String(queueReveal));
}

export function setQueueState(next: QueueState) {
	if (queueState === next) return;
	queueState = next;
	setQueueReveal(next === "closed" ? 0 : 1);
	emit();
}

export function getQueueOpen() {
	return queueState !== "closed";
}

/** `true` reveals the queue at its half (peek) detent, `false` closes it. */
export function setQueueOpen(open: boolean) {
	setQueueState(open ? "half" : "closed");
}

export function toggleQueue() {
	setQueueState(queueState === "closed" ? "half" : "closed");
}

export function useNowPlayingOpen() {
	return useSyncExternalStore(subscribe, getNowPlayingOpen, getNowPlayingOpen);
}

export function useQueueState() {
	return useSyncExternalStore(subscribe, getQueueState, getQueueState);
}

export function useQueueOpen() {
	return useSyncExternalStore(subscribe, getQueueOpen, getQueueOpen);
}
