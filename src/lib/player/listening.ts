/**
 * Shared listening-session tracker. Both YouTube watch-history reporting and
 * the ListenBrainz scrobbler consume it, so "how long counts as a listen"
 * lives in one place instead of being re-implemented per feature.
 */

/** Seconds that must be heard before a play counts as a listen. */
export const LISTEN_GRACE_SECONDS = 5;

/** Seconds listened before a track scrobbles: half of it, clamped to 30s–4min. */
export function scrobbleThresholdSeconds(duration: number): number {
	return Math.max(
		30,
		Math.min(
			Number.isFinite(duration) && duration > 0 ? duration * 0.5 : 240,
			240,
		),
	);
}

export type ListeningEvent = "established" | "scrobbled";

type Listener = (event: ListeningEvent, songId: string) => void;

class ListeningSession {
	#songId: string | null = null;
	#duration = 0;
	#elapsed = 0;
	#established = false;
	#scrobbled = false;
	#listeners = new Set<Listener>();

	/**
	 * Starts tracking `songId`, resetting progress for a new track. Repeated
	 * calls for the same track keep the accumulated time (e.g. after a pause).
	 * The duration is ignored when non-finite: a media element reports NaN or
	 * Infinity until its metadata (MediaSource) is ready, and letting that in
	 * would pin the scrobble threshold to its 4-minute fallback forever.
	 */
	start(songId: string, duration = 0) {
		const seconds = Number.isFinite(duration) ? duration : 0;
		if (this.#songId === songId) {
			if (seconds > 0) this.#duration = seconds;
			return;
		}
		this.#songId = songId;
		this.#duration = seconds;
		this.#elapsed = 0;
		this.#established = false;
		this.#scrobbled = false;
	}

	/** Records the track duration once known (drives the scrobble threshold). */
	setDuration(duration: number) {
		if (!Number.isFinite(duration) || duration <= 0) return;
		if (!Number.isFinite(this.#duration) || duration > this.#duration) {
			this.#duration = duration;
		}
	}

	/** Adds listened seconds; call about once a second while playing. */
	tick(seconds = 1) {
		if (!this.#songId) return;
		this.#elapsed += seconds;
		if (!this.#established && this.#elapsed >= LISTEN_GRACE_SECONDS) {
			this.#established = true;
			this.#emit("established");
		}
		if (
			!this.#scrobbled &&
			this.#elapsed >= scrobbleThresholdSeconds(this.#duration)
		) {
			this.#scrobbled = true;
			this.#emit("scrobbled");
		}
	}

	/** Listened seconds for the current track. */
	get elapsed() {
		return this.#elapsed;
	}

	/** The track currently being tracked, if any. */
	get songId() {
		return this.#songId;
	}

	/** Whether the current track has passed the grace period. */
	get established() {
		return this.#established;
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#emit(event: ListeningEvent) {
		if (!this.#songId) return;
		for (const listener of this.#listeners) listener(event, this.#songId);
	}
}

export const listeningSession = new ListeningSession();
