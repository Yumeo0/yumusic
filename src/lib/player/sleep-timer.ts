import { useSyncExternalStore } from "react";

export type SleepTimer =
	| { mode: "queue" }
	| { mode: "duration"; deadline: number }
	| { mode: "songs"; remaining: number };

/** Local to this listening session; never synced to another device. */
export class SleepTimerStore {
	private state: SleepTimer | null = null;
	private listeners = new Set<() => void>();
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private set(state: SleepTimer | null) {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	cancel = () => this.set(null);
	finishQueue = () => this.set({ mode: "queue" });
	afterMinutes(minutes: number, now = Date.now()) {
		if (!Number.isFinite(minutes) || minutes <= 0) return;
		this.set({
			mode: "duration",
			deadline: now + Math.min(minutes, 1440) * 60_000,
		});
	}
	afterSongs(count: number) {
		if (!Number.isFinite(count) || count < 1) return;
		this.set({ mode: "songs", remaining: Math.min(Math.floor(count), 999) });
	}
	/** Call only at a natural song boundary, before repeat/autoplay advances. */
	trackEnded(index: number, queueLength: number, now = Date.now()): boolean {
		const timer = this.state;
		if (!timer) return false;
		const stop =
			timer.mode === "duration"
				? now >= timer.deadline
				: timer.mode === "queue"
					? index >= queueLength - 1
					: timer.remaining <= 1;
		if (stop) this.cancel();
		else if (timer.mode === "songs")
			this.set({ ...timer, remaining: timer.remaining - 1 });
		return stop;
	}
}

export const sleepTimer = new SleepTimerStore();
export function useSleepTimer() {
	return useSyncExternalStore(sleepTimer.subscribe, sleepTimer.getSnapshot);
}

export function sleepTimerLabel(timer: SleepTimer, now = Date.now()): string {
	if (timer.mode === "queue") return "At the end of the queue";
	if (timer.mode === "songs")
		return `After ${timer.remaining} ${timer.remaining === 1 ? "song" : "songs"}`;
	const seconds = Math.ceil((timer.deadline - now) / 1000);
	if (seconds <= 0) return "After this song finishes";
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · then finish the song`;
}
