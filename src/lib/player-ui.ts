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
let queueOpen = false;

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

export function getQueueOpen() {
	return queueOpen;
}

export function setQueueOpen(open: boolean) {
	if (queueOpen === open) return;
	queueOpen = open;
	emit();
}

export function toggleQueue() {
	setQueueOpen(!queueOpen);
}

export function useNowPlayingOpen() {
	return useSyncExternalStore(subscribe, getNowPlayingOpen, getNowPlayingOpen);
}

export function useQueueOpen() {
	return useSyncExternalStore(subscribe, getQueueOpen, getQueueOpen);
}
