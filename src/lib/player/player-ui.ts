import { createMemo, createSignal } from "solid-js";

/**
 * Module-level store for player *UI* flags (fullscreen open, queue sheet
 * open). These live outside PlayerProvider on purpose: keeping them in the
 * player context touched the shared value on every open/close, while as
 * module signals only the components that actually read a flag update.
 */
const [nowPlayingOpen, writeNowPlayingOpen] = createSignal(false);
/**
 * Queue sheet position. On mobile the queue can rest halfway up (a quick peek
 * that is easy to swipe closed); on desktop anything but "closed" renders as
 * the open drawer.
 */
export type QueueState = "closed" | "half" | "full";
const [queueState, writeQueueState] = createSignal<QueueState>("closed");

/** Reactive flags, read as `nowPlayingOpen()` / `queueState()`. */
export { nowPlayingOpen, queueState };

/** `true` while the queue rests at any open detent. */
export const queueOpen = createMemo(() => queueState() !== "closed");

export function getNowPlayingOpen() {
	return nowPlayingOpen();
}

export function setNowPlayingOpen(open: boolean) {
	if (nowPlayingOpen() === open) return;
	writeNowPlayingOpen(open);
}

export function toggleNowPlaying() {
	setNowPlayingOpen(!nowPlayingOpen());
}

/** Closes the fullscreen player if open; safe to call unconditionally. */
export function closeNowPlaying() {
	setNowPlayingOpen(false);
}

export function getQueueState() {
	return queueState();
}

/**
 * Blend factor (0 = closed layout, 1 = queue-up layout) for fullscreen views
 * that morph while the queue is dragged. Written per frame by the drag
 * gestures, so it is kept as a plain module variable: it must not invalidate
 * any reactive readers. It is applied to the morphing stage element rather
 * than the document root: a custom property on the root invalidates the
 * computed style of every element in the app, which makes drags stutter once
 * the queue list is populated.
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

/**
 * Writes the blend onto the registered target. With no target (mobile lyrics
 * mode replaces the stage) nothing in the tree reads the variable, so the
 * write is skipped entirely: falling back to the document root would
 * invalidate the computed style of every element — lyrics and queue list
 * included — on every frame of the drag.
 */
function applyQueueReveal() {
	const target = queueRevealTarget;
	if (!target) return;
	target.style.setProperty("--queue-reveal", String(queueReveal));
}

export function setQueueState(next: QueueState) {
	if (queueState() === next) return;
	writeQueueState(next);
	setQueueReveal(next === "closed" ? 0 : 1);
}

export function getQueueOpen() {
	return queueState() !== "closed";
}

/** `true` reveals the queue at its half (peek) detent, `false` closes it. */
export function setQueueOpen(open: boolean) {
	setQueueState(open ? "half" : "closed");
}

export function toggleQueue() {
	setQueueState(queueState() === "closed" ? "half" : "closed");
}
