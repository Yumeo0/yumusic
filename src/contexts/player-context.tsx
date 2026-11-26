import {
	createContext,
	type ReactNode,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { YT } from "youtubei.js/web";
import {
	actionCategory,
	queueKey,
	type RoomAction,
} from "@/lib/listen-together/guest-permissions";
import {
	listenRoom,
	useRoomAutoplay,
	useRoomPlaying,
	useRoomRepeat,
	useRoomRole,
	useRoomUsername,
} from "@/lib/listen-together/room";
import type { Song } from "@/lib/music/song";
import { LISTEN_GRACE_SECONDS, listeningSession } from "@/lib/player/listening";
import { NativeAudioElement, nativeAudio } from "@/lib/player/native-audio";
import {
	nextTrack,
	type TransitionTrack,
	type UpcomingTracks,
} from "@/lib/player/next-track";
import { PlaybackDeck, type PlaybackMedia } from "@/lib/player/playback-deck";
import type { RepeatMode } from "@/lib/player/repeat";
import {
	SHARED_AUTOPLAY_LIMIT,
	SHARED_QUEUE_LIMIT,
	sharedQueueWindow,
} from "@/lib/player/shared-playback";
import { shuffleFrom } from "@/lib/player/shuffle";
import { sleepTimer, useSleepTimer } from "@/lib/player/sleep-timer";
import { type LoadedTrack, loadTrack } from "@/lib/player/track-source";
import { useSystemVolume } from "@/lib/player/use-system-volume";
import { DEFAULT_VOLUME, volumeForDevice } from "@/lib/player/volume";
import {
	clampCrossfadeSeconds,
	getSettings,
	useSettings,
} from "@/lib/stores/settings";
import { songVersionReplacement } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { applySongDescription } from "@/lib/utils/description";
import { IS_ANDROID } from "@/lib/utils/tauri";
import { parseDuration } from "@/lib/utils/utils";
import { applyArtistCredits } from "@/lib/youtube/artist-credits";
import { getTrackMeta, type TrackMeta } from "@/lib/youtube/track-meta";
import { getAutoplaySongs } from "@/lib/youtube/track-recommendations";
import {
	reportPlayback,
	reportWatchTime,
	WATCHTIME_PING_MS,
} from "@/lib/youtube/watch-history";

/**
 * Playback state/actions. Deliberately does NOT contain the rapidly-changing
 * `isPlaying` or `volume`: those live in their own contexts below so that a
 * play/pause toggle or a volume drag doesn't recreate this value and
 * re-render every consumer (which used to re-render the whole app shell and
 * current page — the source of the input lag on those controls).
 */
interface PlayerContextType {
	currentSong: Song | null;
	currentAlbum: NonNullable<TrackMeta["album"]> | null;
	currentTrackMeta: TrackMeta | null;
	play: (song: Song, queue?: Song[]) => void;
	/** Replaces the queue with `songs` and starts playing at `index`. */
	playQueue: (songs: Song[], index: number) => void;
	playingVideoId: string | null;
	queue: Song[];
	currentIndex: number;
	autoplayTracks: Song[];
	autoplayEnabled: boolean;
	upcomingTrack: ReturnType<typeof nextTrack>;
	/** The room host owns the shared autoplay setting. */
	setAutoplayEnabled: (enabled: boolean) => void;
	removeAutoplayAt: (index: number) => void;
	/** Plays an autoplay track, promoting it and its predecessors to the queue. */
	playAutoplayAt: (index: number, addedBy?: string) => void;
	addToQueue: (songs: Song[], contributor?: string) => void;
	setQueue: (songs: Song[]) => void;
	/** Starts an empty queue or inserts a song directly after the current one. */
	playNext: (song: Song, contributor?: string) => void;
	/** Remove the entry at `index`; advances playback when it was current. */
	removeFromQueueAt: (index: number) => void;
	/** Shuffles the tracks after the current one; playback stays untouched. */
	shuffleQueue: () => void;
	repeatMode: RepeatMode;
	setRepeatMode: (mode: RepeatMode) => void;
	next: () => void;
	previous: () => void;
	hasNext: boolean;
	hasPrevious: boolean;
	videoElementRef: RefObject<PlaybackMedia | null> | null;
	activeMedia: PlaybackMedia | null;
	/**
	 * Authoritative track length in seconds from YouTube metadata (0 when
	 * unknown). Preferred over the media element's duration, whose exact
	 * value is a fraction shorter than the length YouTube reports in
	 * listings — using it made the player show e.g. 2:54 vs the playlist's 2:55.
	 */
	duration: number;
	seek: (seconds: number) => void;
	prepareRoomTrack: (song: Song, queue: Song[], index: number) => Promise<void>;
	previewRoomTrack: (song: Song | null, queue: Song[], index: number) => void;
	setRoomPlaying: (playing: boolean) => void;
	applyRoomQueue: (songs: Song[], index: number) => void;
	applyRoomAutoplay: (songs: Song[]) => void;
	getPlaybackGeneration: () => number;
}

interface PlayerControlsContextType {
	isPlaying: boolean;
	pause: () => void;
	resume: () => void;
	toggle: () => void;
}

interface PlayerVolumeContextType {
	volume: number;
	setVolume: (volume: number) => void;
	toggleMute: () => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);
const PlayerControlsContext = createContext<
	PlayerControlsContextType | undefined
>(undefined);
const PlayerVolumeContext = createContext<PlayerVolumeContextType | undefined>(
	undefined,
);

/**
 * Seconds before the end of a track at which the next one starts buffering
 * on the idle deck. Allow time for playback setup before the fade or the
 * end of the track. If the preload is still pending, use the normal load path.
 */
const CROSSFADE_PRELOAD_LEAD_SECONDS = 15;

interface CrossfadeState {
	phase: "preload" | "transitioning" | "failed";
	controller: AbortController;
	target: TransitionTrack;
	incoming: LoadedTrack | null;
	fromSong: Song;
	deckIndex: number;
	seconds: number;
	endedAt?: number;
	/**
	 * Advances the ramp one step. Called by rAF while the window renders and
	 * again on every timeupdate, so a backgrounded window (where rAF is
	 * paused) still completes the fade on the audio clock.
	 */
	advance: (() => void) | null;
}

interface AutoplayRequest {
	songId: string;
	tracks: Promise<Song[]>;
	seeded: boolean;
	empty: boolean;
}

function sameTarget(left: TransitionTrack, right: TransitionTrack | null) {
	return (
		left.kind === right?.kind &&
		left.index === right.index &&
		left.song.id === right.song.id
	);
}

function sendGuestAction(action: RoomAction) {
	const result = listenRoom.requestAction(action);
	if (result === "disconnected")
		showToast("Wait until you are connected to the room.");
	else if (result === "denied")
		showToast("The host does not allow this action.");
	else if (
		listenRoom.getSnapshot().permissions[actionCategory(action)] === "suggest"
	)
		showToast("Request sent to the host.");
}
function localControl<T extends unknown[]>(
	action: (...args: T) => unknown,
	remote?: (...args: T) => RoomAction,
) {
	return (...args: T) => {
		if (listenRoom.getSnapshot().role === "guest") {
			if (remote) sendGuestAction(remote(...args));
			else showToast("The host controls this action.");
			return;
		}
		return action(...args);
	};
}
function selectionAction(songs: Song[], index: number): RoomAction {
	const window = sharedQueueWindow(songs, index);
	return { type: "playQueue", songs: window.queue, index: window.index };
}

function attributeLocal(song: Song): Song {
	const room = listenRoom.getSnapshot();
	const username = room.members.find((m) => m.id === room.selfId)?.profile
		.username;
	return room.role === "host" && username && !song.addedBy
		? { ...song, addedBy: username }
		: song;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
	const systemVolume = useSystemVolume();
	const activeSleepTimer = useSleepTimer();
	const roomRole = useRoomRole();
	const roomPlaying = useRoomPlaying();
	const roomUsername = useRoomUsername();
	const [settings, updateSettings] = useSettings();
	const roomAutoplay = useRoomAutoplay();
	const autoplayEnabled =
		roomRole === "guest" ? roomAutoplay : settings.autoplay;
	const setAutoplayEnabled = useCallback(
		(enabled: boolean) => {
			if (listenRoom.getSnapshot().role !== "guest")
				updateSettings({ autoplay: enabled });
		},
		[updateSettings],
	);
	const sharedRepeat = useRoomRepeat();
	const repeatMode = sharedRepeat ?? settings.repeatMode;
	const setRepeatMode = useCallback(
		(mode: RepeatMode) => updateSettings({ repeatMode: mode }),
		[updateSettings],
	);
	const [currentSong, setCurrentSong] = useState<Song | null>(null);
	const [selectedTrackMeta, setSelectedTrackMeta] = useState<{
		songId: string;
		meta: TrackMeta | null;
	} | null>(null);
	const currentSongId = currentSong?.id;
	const currentTrackMeta =
		selectedTrackMeta?.songId === currentSongId
			? (selectedTrackMeta?.meta ?? null)
			: null;
	const [videoInfo, setVideoInfo] = useState<YT.VideoInfo | null>(null);
	const streamed = videoInfo !== null;
	useEffect(() => {
		if (!currentSongId) return;
		let cancelled = false;
		void getTrackMeta(currentSongId).then((meta) => {
			if (!cancelled) setSelectedTrackMeta({ songId: currentSongId, meta });
		});
		return () => {
			cancelled = true;
		};
	}, [currentSongId]);
	useEffect(() => {
		if (!currentSongId || !currentTrackMeta) return;
		const upload = streamed && !currentTrackMeta.album;
		const artists = currentTrackMeta.artists;
		if (!upload && artists.length === 0) return;
		const enrich = (song: Song) => {
			if (song.id !== currentSongId) return song;
			const credited = artists.length
				? applyArtistCredits(song, artists)
				: song;
			return upload && !credited.upload ? { ...credited, upload } : credited;
		};
		setCurrentSong((song) => (song ? enrich(song) : song));
		setQueueState((songs) => songs.map(enrich));
		setAutoplayTracks((songs) => songs.map(enrich));
	}, [currentSongId, currentTrackMeta, streamed]);
	const [isPlaying, setIsPlaying] = useState(false);
	const [queue, setQueueState] = useState<Song[]>([]);
	const [currentIndex, setCurrentIndex] = useState(-1);
	const [autoplayTracks, setAutoplayTracks] = useState<Song[]>([]);
	const [history, setHistory] = useState<Song[]>([]);
	const upcoming = useMemo<UpcomingTracks>(
		() => ({
			queue,
			currentSong,
			currentIndex,
			repeatMode,
			autoplayTracks,
			autoplayEnabled,
		}),
		[
			queue,
			currentSong,
			currentIndex,
			repeatMode,
			autoplayTracks,
			autoplayEnabled,
		],
	);
	const upcomingRef = useRef(upcoming);
	upcomingRef.current = upcoming;
	const queueSheetRef = useRef<HTMLElement | null>(null);
	const deckARef = useRef<PlaybackMedia | null>(null);
	const deckBRef = useRef<PlaybackMedia | null>(null);
	const attachDeckA = useCallback((media: HTMLVideoElement | null) => {
		deckARef.current = media;
	}, []);
	const attachDeckB = useCallback((media: HTMLVideoElement | null) => {
		deckBRef.current = media;
	}, []);
	const endedHandlerRef = useRef<(index: number) => void>(() => undefined);
	const activeDeckRef = useRef(0);
	const videoElementRef = useRef<PlaybackMedia | null>(null);
	const [activeMedia, setActiveMedia] = useState<PlaybackMedia | null>(null);
	const exposeMedia = useCallback((media: PlaybackMedia | null) => {
		videoElementRef.current = media;
		setActiveMedia(media);
	}, []);
	const decksRef = useRef<PlaybackDeck[]>([]);
	if (decksRef.current.length === 0) {
		decksRef.current = [new PlaybackDeck(deckARef), new PlaybackDeck(deckBRef)];
	}
	const crossfadeRef = useRef<CrossfadeState | null>(null);
	const crossfadeRafRef = useRef<number | null>(null);
	const updateCrossfadeRef = useRef<() => void>(() => undefined);
	const loadRequestRef = useRef(0);
	const loadControllerRef = useRef<AbortController | null>(null);
	const cancelTrackLoad = useCallback(() => {
		loadControllerRef.current?.abort();
		loadControllerRef.current = null;
		return ++loadRequestRef.current;
	}, []);
	const preparingTrackRef = useRef<number | null>(null);
	const autoplayRequestRef = useRef<AutoplayRequest | null>(null);
	const loadAutoplay = useCallback((songId: string, retryEmpty = false) => {
		const existing = autoplayRequestRef.current;
		if (existing?.songId === songId && !(retryEmpty && existing.empty))
			return existing;
		const request: AutoplayRequest = {
			songId,
			seeded: false,
			empty: false,
			tracks: getAutoplaySongs(songId).then((tracks) => {
				request.empty = tracks.length === 0;
				return tracks;
			}),
		};
		autoplayRequestRef.current = request;
		return request;
	}, []);
	const [preferredVolume, setPreferredVolume] = useState(() => {
		const saved = Number.parseFloat(
			localStorage.getItem("yumusic-volume") ?? "",
		);
		const current = Number.isFinite(saved)
			? volumeForDevice(saved, false)
			: DEFAULT_VOLUME;
		return { current, audible: current || DEFAULT_VOLUME };
	});
	const volume = volumeForDevice(preferredVolume.current, systemVolume);

	const getVolume = useCallback(() => volumeRef.current, []);
	const volumeRef = useRef(volume);
	volumeRef.current = volume;

	useEffect(() => {
		if (!IS_ANDROID) {
			exposeMedia(deckARef.current);
			return;
		}
		const elements = [new NativeAudioElement(0), new NativeAudioElement(1)];
		elements.forEach((element, index) => {
			decksRef.current[index].ref.current = element;
			element.addEventListener("ended", () => endedHandlerRef.current(index));
		});
		exposeMedia(decksRef.current[activeDeckRef.current].ref.current);
		return () => {
			for (const element of elements) element.dispose();
		};
	}, [exposeMedia]);

	const abortCrossfade = useCallback(() => {
		const state = crossfadeRef.current;
		if (!state) return;
		crossfadeRef.current = null;
		state.controller.abort();
		if (crossfadeRafRef.current !== null) {
			cancelAnimationFrame(crossfadeRafRef.current);
			crossfadeRafRef.current = null;
		}
		const activeEl = decksRef.current[activeDeckRef.current]?.ref.current;
		if (activeEl) activeEl.volume = volumeRef.current;
		decksRef.current[state.deckIndex].reset();
	}, []);

	const stopForSleepTimer = useCallback(
		(endedAt?: number) => {
			if (!sleepTimer.trackEnded(currentIndex, queue.length, endedAt))
				return false;
			abortCrossfade();
			videoElementRef.current?.pause();
			setIsPlaying(false);
			if (listenRoom.getSnapshot().role === "guest")
				listenRoom.setGuestAudio("remote");
			showToast("Sleep timer finished");
			return true;
		},
		[abortCrossfade, currentIndex, queue.length],
	);

	const commitCrossfade = useCallback(
		(state: CrossfadeState, skipped = false) => {
			const nextEl = decksRef.current[state.deckIndex]?.ref.current;
			if (crossfadeRef.current !== state || !state.incoming || !nextEl) {
				return false;
			}
			const oldDeck = decksRef.current[activeDeckRef.current];
			// A timer changed during the fade. Finish the outgoing song at full gain.
			if (
				!skipped &&
				!oldDeck.ref.current?.ended &&
				sleepTimer.shouldStopAtTrackEnd(
					currentIndex,
					queue.length,
					state.endedAt,
				)
			) {
				abortCrossfade();
				return false;
			}
			if (!skipped && stopForSleepTimer(state.endedAt)) return false;
			crossfadeRef.current = null;
			if (crossfadeRafRef.current !== null) {
				cancelAnimationFrame(crossfadeRafRef.current);
				crossfadeRafRef.current = null;
			}

			activeDeckRef.current = state.deckIndex;
			exposeMedia(nextEl);
			nextEl.volume = volumeRef.current;

			const { target, incoming } = state;
			setHistory((prev) => [...prev.slice(-99), state.fromSong]);
			setCurrentIndex(target.index);
			if (target.kind === "autoplay") {
				setQueueState((prev) => [...prev, incoming.song]);
				setAutoplayTracks((prev) => prev.slice(1));
			} else if (incoming.song.id !== target.song.id) {
				setQueueState((prev) =>
					prev.map((entry) =>
						entry.id === target.song.id
							? { ...incoming.song, addedBy: entry.addedBy }
							: entry,
					),
				);
			}

			const { artwork, song, videoInfo } = incoming;
			setCurrentSong(artwork ? { ...song, thumbnail: artwork } : song);
			setVideoInfo(videoInfo ?? null);
			setIsPlaying(true);

			oldDeck.reset();
			return true;
		},
		[
			abortCrossfade,
			currentIndex,
			exposeMedia,
			queue.length,
			stopForSleepTimer,
		],
	);

	/**
	 * Starts a preloaded track. With an overlap, the incoming deck starts muted and
	 * the two are ramped with equal-power curves over the overlap length.
	 * The ramp follows the audio clock, so throttled frames in a background
	 * window still reach the handover; rAF only smooths the visible steps.
	 */
	const startTransition = useCallback(
		(state: CrossfadeState) => {
			const nextEl = decksRef.current[state.deckIndex]?.ref.current;
			const currentEl = decksRef.current[activeDeckRef.current]?.ref.current;
			if (
				!nextEl ||
				!currentEl ||
				!state.incoming ||
				state.phase !== "preload"
			) {
				return;
			}
			state.phase = "transitioning";

			const currentNative = nativeAudio(currentEl);
			const nextNative = nativeAudio(nextEl);
			if (currentNative && nextNative) {
				currentNative.crossfadeTo(nextNative, state.seconds, (completed) => {
					if (crossfadeRef.current !== state) return;
					if (completed) {
						commitCrossfade(state);
						return;
					}
					// Let the normal end handler load the next track if the overlap failed.
					state.phase = "failed";
					decksRef.current[state.deckIndex].reset();
					if (currentNative.ended)
						endedHandlerRef.current(activeDeckRef.current);
				});
				return;
			}

			// If the preload landed late, shorten the fade so it still ends
			// roughly where the track does instead of trailing into silence.
			const remaining = Number.isFinite(currentEl.duration)
				? Math.max(currentEl.duration - currentEl.currentTime, 0.5)
				: state.seconds;
			const fadeSeconds = Math.max(Math.min(state.seconds, remaining), 0.1);
			const fadeStartTime = currentEl.currentTime;

			nextEl.volume = 0;
			nextEl.play().catch((error) => {
				if ((error as Error).name === "AbortError") return;
				console.warn("[PlayerContext] Crossfade playback failed:", error);
				if (crossfadeRef.current === state) abortCrossfade();
			});

			const advance = () => {
				if (crossfadeRef.current !== state) return;
				// Both native timeupdate and rAF can drive this ramp. Replace
				// the pending frame instead of spawning another animation loop.
				if (crossfadeRafRef.current !== null) {
					cancelAnimationFrame(crossfadeRafRef.current);
					crossfadeRafRef.current = null;
				}
				// Progress comes from the audio clock, not wall time, so the
				// ramp stays aligned even if the app is throttled in the
				// background between steps.
				const elapsed = currentEl.currentTime - fadeStartTime;
				const t = Math.min(1, Math.max(0, elapsed / fadeSeconds));
				const volume = volumeRef.current;
				currentEl.volume = volume * Math.cos((t * Math.PI) / 2);
				nextEl.volume = volume * Math.sin((t * Math.PI) / 2);
				if (t >= 1) {
					commitCrossfade(state);
					return;
				}
				crossfadeRafRef.current = requestAnimationFrame(advance);
			};
			state.advance = advance;
			advance();
		},
		[abortCrossfade, commitCrossfade],
	);

	const handoffPreparedTrack = useCallback(
		(target: TransitionTrack | null, endedAt?: number) => {
			const state = crossfadeRef.current;
			if (
				listenRoom.getSnapshot().role ||
				state?.phase !== "preload" ||
				!state.incoming ||
				!sameTarget(state.target, target)
			) {
				return false;
			}
			const deck = decksRef.current[state.deckIndex];
			const nextEl = deck.ref.current;
			if (!deck.ready || !nextEl) return false;

			const request = cancelTrackLoad();
			state.endedAt = endedAt;
			if (endedAt !== undefined && IS_ANDROID) {
				state.seconds = 0;
				startTransition(state);
				return true;
			}

			if (commitCrossfade(state, endedAt === undefined)) {
				const src = nextEl.src;
				const isCurrent = () =>
					request === loadRequestRef.current &&
					videoElementRef.current === nextEl &&
					nextEl.src === src;
				void deck.play().then(
					(started) => {
						if (!started && isCurrent() && nextEl.paused) setIsPlaying(false);
					},
					(error: unknown) => {
						if (!isCurrent()) return;
						deck.reset();
						setIsPlaying(false);
						console.warn(
							"[PlayerContext] Prepared track could not play:",
							error,
						);
					},
				);
			}
			return true;
		},
		[cancelTrackLoad, commitCrossfade, startTransition],
	);

	const armCrossfade = useCallback(
		async (target: TransitionTrack, seconds: number, fromSong: Song) => {
			if (crossfadeRef.current) return;
			const deckIndex = activeDeckRef.current === 0 ? 1 : 0;
			const deck = decksRef.current[deckIndex];

			const state: CrossfadeState = {
				advance: null,
				controller: new AbortController(),
				deckIndex,
				fromSong,
				phase: "preload",
				target,
				incoming: null,
				seconds,
			};
			crossfadeRef.current = state;
			const isCurrent = () => crossfadeRef.current === state;
			const fail = (error: unknown) => {
				if (isCurrent()) {
					if (state.phase === "transitioning") {
						abortCrossfade();
						crossfadeRef.current = state;
					}
					state.phase = "failed";
					if (videoElementRef.current?.ended)
						endedHandlerRef.current(activeDeckRef.current);
				} else if (activeDeckRef.current === deckIndex) {
					setIsPlaying(false);
				}
				console.error("[player] Preloaded track failed:", error);
			};
			try {
				state.incoming = await loadTrack(deck, target.song, {
					intent: "preload",
					signal: state.controller.signal,
					volume: getVolume,
					onPlaybackError: fail,
				});
				updateCrossfadeRef.current();
			} catch (error) {
				if (isCurrent()) fail(error);
			}
		},
		[abortCrossfade, getVolume],
	);

	const nextTransitionTrack = useCallback(
		(finishQueue: boolean): TransitionTrack | null => {
			const target = nextTrack(upcoming, "ended", finishQueue);
			return target && "index" in target ? target : null;
		},
		[upcoming],
	);

	const updateCrossfade = useCallback(() => {
		const seconds = settings.crossfade
			? clampCrossfadeSeconds(settings.crossfadeSeconds)
			: 0;
		const activeEl = decksRef.current[activeDeckRef.current]?.ref.current;
		if (roomRole || !isPlaying || !currentSong || !activeEl) {
			abortCrossfade();
			return;
		}

		const state = crossfadeRef.current;
		// The outgoing song has ended and Android is confirming the handover.
		if (state?.phase === "transitioning" && state.endedAt !== undefined) return;
		const target = nextTransitionTrack(activeSleepTimer?.mode === "queue");
		if (
			!target ||
			sleepTimer.shouldStopAtTrackEnd(currentIndex, queue.length)
		) {
			abortCrossfade();
			return;
		}

		if (state && !sameTarget(state.target, target)) abortCrossfade();

		const duration = activeEl.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;
		const remaining = duration - activeEl.currentTime;

		if (remaining > seconds + CROSSFADE_PRELOAD_LEAD_SECONDS) {
			if (crossfadeRef.current) abortCrossfade();
			return;
		}

		const armed = crossfadeRef.current;
		if (!armed) {
			void armCrossfade(target, seconds, currentSong);
			return;
		}
		// A duration timer can expire during the overlap. Keep the preload, but
		// wait for the actual end if the deadline is likely to fall in this song.
		const expectedEnd =
			Date.now() + (Math.max(remaining, 0) * 1000) / activeEl.playbackRate;
		const canFade =
			seconds > 0 &&
			!sleepTimer.shouldStopAtTrackEnd(currentIndex, queue.length, expectedEnd);
		if (armed.phase === "transitioning") {
			if (canFade) armed.advance?.();
			else abortCrossfade();
			return;
		}
		const deck = decksRef.current[armed.deckIndex];
		if (
			armed.phase === "preload" &&
			canFade &&
			deck?.ready &&
			armed.incoming &&
			remaining <= seconds
		) {
			armed.seconds = seconds;
			startTransition(armed);
		}
	}, [
		roomRole,
		activeSleepTimer,
		settings.crossfade,
		settings.crossfadeSeconds,
		isPlaying,
		currentSong,
		currentIndex,
		queue.length,
		abortCrossfade,
		armCrossfade,
		nextTransitionTrack,
		startTransition,
	]);
	updateCrossfadeRef.current = updateCrossfade;

	useEffect(() => {
		updateCrossfade();
		const videoEl = activeMedia;
		if (!videoEl) return;
		const onTimeUpdate = () => updateCrossfade();
		const onSeeking = () => abortCrossfade();
		videoEl.addEventListener("timeupdate", onTimeUpdate);
		videoEl.addEventListener("seeking", onSeeking);
		videoEl.addEventListener("seeked", onTimeUpdate);
		return () => {
			videoEl.removeEventListener("timeupdate", onTimeUpdate);
			videoEl.removeEventListener("seeking", onSeeking);
			videoEl.removeEventListener("seeked", onTimeUpdate);
		};
	}, [activeMedia, updateCrossfade, abortCrossfade]);

	// YouTube uses watched ranges to restore the saved resume position.
	useEffect(() => {
		if (!settings.watchHistory || !videoInfo || !activeMedia) return;
		const videoEl = activeMedia;

		let lastReported = videoEl.currentTime;
		let lastKnownTime = lastReported;
		let seeking = false;

		const send = (final: boolean) => {
			if (seeking) return;
			const end = lastKnownTime;
			if (end - lastReported < LISTEN_GRACE_SECONDS) {
				if (final) lastReported = end;
				return;
			}
			reportWatchTime(videoInfo, lastReported, end, final);
			lastReported = end;
		};

		const onTimeUpdate = () => {
			if (!videoEl.paused) lastKnownTime = videoEl.currentTime;
		};
		const onSeeking = () => {
			seeking = true;
		};
		const onSeeked = () => {
			lastReported = videoEl.currentTime;
			lastKnownTime = lastReported;
			seeking = false;
		};
		const onPause = () => send(false);

		videoEl.addEventListener("timeupdate", onTimeUpdate);
		videoEl.addEventListener("seeking", onSeeking);
		videoEl.addEventListener("seeked", onSeeked);
		videoEl.addEventListener("pause", onPause);
		const timer = window.setInterval(() => {
			if (!videoEl.paused) send(false);
		}, WATCHTIME_PING_MS);

		return () => {
			window.clearInterval(timer);
			videoEl.removeEventListener("timeupdate", onTimeUpdate);
			videoEl.removeEventListener("seeking", onSeeking);
			videoEl.removeEventListener("seeked", onSeeked);
			videoEl.removeEventListener("pause", onPause);
			send(true);
		};
	}, [activeMedia, settings.watchHistory, videoInfo]);

	useEffect(() => {
		if (!activeMedia || activeMedia.readyState < 2) return;

		if (isPlaying && activeMedia.paused) {
			void activeMedia.play().catch((error) => {
				if (error.name === "AbortError") return;
				if (activeMedia === videoElementRef.current && activeMedia.paused)
					setIsPlaying(false);
				console.error("Playback failed", error);
			});
		} else if (!isPlaying && !activeMedia.paused) {
			activeMedia.pause();
		}
	}, [activeMedia, isPlaying]);

	// Mirror the element's real playback state back into React: OS/headset
	// media keys pause the element directly, bypassing setIsPlaying — without
	// this the UI shows "playing" while audio is paused and the play button
	// needs two clicks to resume. Only the active deck counts: the idle one
	// is paused and torn down around crossfades and must not flip the UI.
	useEffect(() => {
		const elements = [deckARef.current, deckBRef.current].filter(
			(el): el is PlaybackMedia => el !== null,
		);
		const sync = (event: Event) => {
			const media = videoElementRef.current;
			if (media && event.currentTarget === media) setIsPlaying(!media.paused);
		};
		for (const el of elements) {
			el.addEventListener("play", sync);
			el.addEventListener("pause", sync);
		}
		return () => {
			for (const el of elements) {
				el.removeEventListener("play", sync);
				el.removeEventListener("pause", sync);
			}
		};
	}, []);

	useEffect(() => {
		if (activeMedia) activeMedia.volume = volume;
		if (!systemVolume)
			localStorage.setItem("yumusic-volume", volume.toString());
	}, [activeMedia, volume, systemVolume]);

	const setVolume = useCallback(
		(next: number) => {
			if (systemVolume || !Number.isFinite(next)) return;
			const current = volumeForDevice(next, false);
			setPreferredVolume((previous) => ({
				current,
				audible: current || previous.audible,
			}));
		},
		[systemVolume],
	);
	const toggleMute = useCallback(() => {
		if (systemVolume) return;
		setPreferredVolume((previous) => ({
			...previous,
			current: previous.current > 0 ? 0 : previous.audible,
		}));
	}, [systemVolume]);

	const playSong = useCallback(
		async (song: Song, exact = false) => {
			abortCrossfade();
			const request = cancelTrackLoad();
			const controller = new AbortController();
			loadControllerRef.current = controller;
			const { signal } = controller;
			preparingTrackRef.current = request;
			const deck = decksRef.current[activeDeckRef.current];
			deck.reset();
			setIsPlaying(false);
			setCurrentSong(song);
			setVideoInfo(null);
			try {
				const {
					artwork,
					videoInfo: streamInfo,
					song: played,
					description,
				} = await loadTrack(deck, song, {
					intent: exact ? "prepare" : "play",
					signal,
					volume: getVolume,
					onPlaybackError: (error) => {
						setIsPlaying(false);
						console.error("[player] Active track failed:", error);
					},
				});
				signal.throwIfAborted();

				if (streamInfo && (played.id !== song.id || description)) {
					const enrich = (entry: Song) => {
						if (entry.id === song.id && played.id !== song.id)
							return { ...played, addedBy: entry.addedBy };
						if (description && entry.id === played.id)
							return applySongDescription(entry, description);
						return entry;
					};
					setQueueState((previous) => previous.map(enrich));
					setAutoplayTracks((previous) => previous.map(enrich));
				}
				setCurrentSong((previous) => {
					const current =
						previous?.id === played.id
							? description
								? applySongDescription(previous, description)
								: previous
							: played;
					return artwork ? { ...current, thumbnail: artwork } : current;
				});
				setVideoInfo(streamInfo ?? null);
				setIsPlaying(!exact && deck.ref.current?.paused === false);
			} catch (error) {
				if (!signal.aborted) {
					setIsPlaying(false);
					console.error("[player] Failed to play song:", error);
				}
				if (exact) throw error;
			} finally {
				if (loadControllerRef.current === controller)
					loadControllerRef.current = null;
				if (preparingTrackRef.current === request)
					preparingTrackRef.current = null;
			}
		},
		[abortCrossfade, cancelTrackLoad, getVolume],
	);
	const resume = useCallback(() => {
		if (!currentSong) return;
		const deck = decksRef.current[activeDeckRef.current];
		const media = deck.ref.current;
		if (!deck.ready || !media || media.error) {
			if (preparingTrackRef.current !== loadRequestRef.current)
				void playSong(currentSong);
			return;
		}
		void media.play().catch((error: unknown) => {
			if (!(error instanceof Error) || error.name !== "AbortError") {
				console.error("[player] Resume failed:", error);
			}
		});
	}, [currentSong, playSong]);

	const currentDuration =
		parseDuration(currentSong?.duration) || videoInfo?.basic_info.duration || 0;
	useEffect(() => {
		if (!currentSongId || !isPlaying || !activeMedia) return;
		const elementDuration = Number.isFinite(activeMedia.duration)
			? activeMedia.duration
			: 0;
		listeningSession.start(currentSongId, elementDuration || currentDuration);
		const timer = window.setInterval(() => {
			if (
				activeMedia.paused ||
				activeMedia.seeking ||
				activeMedia.readyState < 3
			)
				return;
			listeningSession.setDuration(activeMedia.duration);
			listeningSession.tick(1);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [activeMedia, currentSongId, currentDuration, isPlaying]);

	// Register the play in YouTube's watch history — the same ping the web
	// player sends — once the track has passed the shared grace period, so
	// instant skips are never tracked. The session tracks the requested
	// song's id, which differs from the streamed id when a song version is
	// playing, so compare against the song, not the stream.
	useEffect(() => {
		if (!settings.watchHistory || !videoInfo || !currentSong) return;
		const songId = currentSong.id;
		return listeningSession.subscribe((event, eventSongId) => {
			if (event !== "established") return;
			if (eventSongId !== songId) return;
			reportPlayback(videoInfo);
		});
	}, [settings.watchHistory, videoInfo, currentSong]);

	const autoplaySongId = currentSong?.id ?? null;
	useEffect(() => {
		if (roomRole === "guest") return;
		if (!settings.autoplay || !autoplaySongId) {
			setAutoplayTracks([]);
			autoplayRequestRef.current = null;
			return;
		}
		if (autoplayTracks.length > 0) return;
		const request = loadAutoplay(autoplaySongId);
		if (request.seeded) return;
		let cancelled = false;
		void request.tracks.then((tracks) => {
			if (cancelled || request.seeded || autoplayRequestRef.current !== request)
				return;
			request.seeded = true;
			setAutoplayTracks(tracks);
		});
		return () => {
			cancelled = true;
		};
	}, [
		roomRole,
		settings.autoplay,
		autoplaySongId,
		autoplayTracks.length,
		loadAutoplay,
	]);

	const play = useCallback(
		async (song: Song, newQueue?: Song[]) => {
			// The entry may resolve to its album track: match and queue that.
			const target = attributeLocal({
				...(songVersionReplacement(song.id) ?? song),
				addedBy: song.addedBy,
			});
			if (currentSong?.id === target.id) {
				resume();
				return;
			}

			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}

			setAutoplayTracks([]);
			autoplayRequestRef.current = null;

			if (newQueue) {
				setQueueState([target, ...newQueue.map(attributeLocal)]);
				setCurrentIndex(0);
			} else {
				const index = queue.findIndex((s) => s.id === target.id);
				if (index !== -1) {
					setCurrentIndex(index);
				} else {
					setQueueState([target, ...queue]);
					setCurrentIndex(0);
				}
			}

			await playSong(target);
		},
		[currentSong, queue, playSong, resume],
	);

	/**
	 * Starts a list at `index` with the whole list as the queue, so previous
	 * and next walk the list in both directions.
	 */
	const playQueue = useCallback(
		async (songs: Song[], index: number) => {
			songs = songs.map(attributeLocal);
			const song = songs[index];
			if (!song) return;
			// The entry may resolve to its album track: match and queue that.
			const target = {
				...(songVersionReplacement(song.id) ?? song),
				addedBy: song.addedBy,
			};
			if (currentSong?.id === target.id) {
				resume();
				return;
			}
			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}
			setAutoplayTracks([]);
			autoplayRequestRef.current = null;
			setQueueState(songs.map((entry, i) => (i === index ? target : entry)));
			setCurrentIndex(index);
			await playSong(target);
		},
		[currentSong, playSong, resume],
	);

	const advance = useCallback(
		async (trigger: "skip" | "ended") => {
			const finishingQueue = () => sleepTimer.getSnapshot()?.mode === "queue";
			let tracks = upcomingRef.current;
			let target = nextTrack(tracks, trigger, finishingQueue());
			if (target?.kind === "radio") {
				const generation = loadRequestRef.current;
				const request = loadAutoplay(target.song.id, true);
				const radio = await request.tracks;
				if (
					generation !== loadRequestRef.current ||
					autoplayRequestRef.current !== request ||
					listenRoom.getSnapshot().role === "guest"
				)
					return;
				tracks = upcomingRef.current;
				tracks = {
					...tracks,
					autoplayEnabled: getSettings().autoplay,
					autoplayTracks: tracks.autoplayTracks.length
						? tracks.autoplayTracks
						: radio,
				};
				target = nextTrack(tracks, trigger, finishingQueue());
				if (target?.kind === "autoplay") request.seeded = true;
			}
			if (!target || target.kind === "radio") return;
			if (!("index" in target)) {
				listeningSession.reset();
				await playSong(target.song);
				return;
			}
			if (trigger === "skip" && handoffPreparedTrack(target)) return;
			if (target.kind === "autoplay") {
				setAutoplayTracks(tracks.autoplayTracks.slice(1));
				setQueueState([...tracks.queue, target.song]);
			}
			const leaving = tracks.currentSong;
			if (leaving) setHistory((prev) => [...prev.slice(-99), leaving]);
			setCurrentIndex(target.index);
			await playSong(target.song);
		},
		[handoffPreparedTrack, loadAutoplay, playSong],
	);

	/**
	 * Natural end of the audible deck: normally advance, but a running fade
	 * owns the transition (its commit switches decks), and the idle deck must
	 * never advance anything when its buffered stream ends.
	 */
	const handleEnded = useCallback(
		(deckIndex: number) => {
			if (deckIndex !== activeDeckRef.current) return;
			const endedAt = Date.now();
			const state = crossfadeRef.current;
			if (state?.phase === "transitioning") {
				// Count this song when the fade commits or falls back to a normal transition.
				state.endedAt ??= endedAt;
				if (state.advance) commitCrossfade(state);
				return;
			}

			const queueTimer = sleepTimer.getSnapshot()?.mode === "queue";
			const guest = listenRoom.getSnapshot().role === "guest";
			if (
				!guest &&
				!sleepTimer.shouldStopAtTrackEnd(currentIndex, queue.length, endedAt) &&
				handoffPreparedTrack(nextTransitionTrack(queueTimer), endedAt)
			)
				return;
			if (stopForSleepTimer(state?.endedAt ?? endedAt) || guest) return;
			setIsPlaying(false);
			void advance("ended");
		},
		[
			commitCrossfade,
			advance,
			nextTransitionTrack,
			handoffPreparedTrack,
			stopForSleepTimer,
			currentIndex,
			queue.length,
		],
	);

	// The provider owns both decks; free their streams when it goes away.
	useEffect(() => {
		return () => {
			cancelTrackLoad();
			abortCrossfade();
			for (const deck of decksRef.current) deck.reset();
		};
	}, [abortCrossfade, cancelTrackLoad]);

	const previous = useCallback(async () => {
		if (currentIndex > 0 || (repeatMode === "all" && queue.length > 0)) {
			const prevIndex = currentIndex > 0 ? currentIndex - 1 : queue.length - 1;
			const prevSong = queue[prevIndex];

			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}

			setCurrentIndex(prevIndex);
			await playSong(prevSong);
			return;
		}

		if (history.length === 0) return;

		const previousSong = history[history.length - 1];
		const newHistory = history.slice(0, -1);

		if (currentSong) {
			setQueueState((prev) => [currentSong, ...prev]);
			setCurrentIndex(0);
		}

		setHistory(newHistory);
		await playSong(previousSong);
	}, [currentIndex, queue, history, currentSong, playSong, repeatMode]);

	const playAutoplayAt = useCallback(
		(index: number, addedBy?: string) => {
			const promoted = autoplayTracks
				.slice(0, index + 1)
				.map((song) => (addedBy ? { ...song, addedBy } : attributeLocal(song)));
			const picked = promoted[index];
			if (!picked) return;
			// Everything up to the picked track joins the user queue above the
			// separator; the rest stays in the autoplay section.
			setAutoplayTracks(autoplayTracks.slice(index + 1));
			setQueueState((prev) => [...prev, ...promoted]);
			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}
			setCurrentIndex(queue.length + index);
			void playSong(picked);
		},
		[autoplayTracks, queue.length, currentSong, playSong],
	);

	const addToQueue = useCallback((songs: Song[], contributor?: string) => {
		const additions = songs.map((song) =>
			attributeLocal({ ...song, addedBy: contributor }),
		);
		setQueueState((prev) => [...prev, ...additions]);
	}, []);

	const playNext = useCallback(
		(song: Song, contributor?: string) => {
			const requested = { ...song, addedBy: contributor };
			if (!currentSong && queue.length === 0) return play(requested);

			const addition = attributeLocal(requested);
			const insertAt = currentIndex < 0 ? 0 : currentIndex + 1;
			setQueueState((prev) => {
				const next = [...prev];
				next.splice(insertAt, 0, addition);
				return next;
			});
			showToast("Playing next");
		},
		[currentIndex, currentSong, queue.length, play],
	);

	const removeFromQueueAt = useCallback(
		(index: number) => {
			const nextQueue = queue.filter((_, i) => i !== index);
			setQueueState(nextQueue);
			if (index === currentIndex) {
				// Removing the playing entry advances to what now occupies its
				// slot, so audio and highlighted row stay in sync.
				if (nextQueue.length === 0) {
					cancelTrackLoad();
					abortCrossfade();
					setIsPlaying(false);
					setCurrentSong(null);
					setVideoInfo(null);
					const deck = decksRef.current[activeDeckRef.current];
					deck.reset();
					setCurrentIndex(-1);
				} else {
					const nextIndex = Math.min(currentIndex, nextQueue.length - 1);
					setCurrentIndex(nextIndex);
					void playSong(nextQueue[nextIndex]);
				}
			} else if (index < currentIndex) {
				setCurrentIndex(currentIndex - 1);
			}
		},
		[queue, currentIndex, playSong, cancelTrackLoad, abortCrossfade],
	);

	const shuffleQueue = useCallback(() => {
		setQueueState((prev) => shuffleFrom(prev, currentIndex + 1));
	}, [currentIndex]);

	const setQueue = useCallback(
		(songs: Song[]) => {
			const current = queue[currentIndex];
			const nextIndex = current ? songs.indexOf(current) : -1;
			if (nextIndex >= 0) setCurrentIndex(nextIndex);
			setQueueState(songs);
		},
		[queue, currentIndex],
	);

	const pause = useCallback(() => setIsPlaying(false), []);
	const toggle = useCallback(() => {
		if (isPlaying) pause();
		else resume();
	}, [isPlaying, pause, resume]);

	const finishingQueue =
		roomRole !== "guest" && activeSleepTimer?.mode === "queue";
	const upcomingTrack = useMemo(
		() => nextTrack(upcoming, "ended", finishingQueue),
		[upcoming, finishingQueue],
	);
	const hasNext = nextTrack(upcoming, "skip", finishingQueue) !== null;
	const hasPrevious =
		currentIndex > 0 ||
		history.length > 0 ||
		(repeatMode === "all" && queue.length > 0);

	const seek = useCallback((seconds: number) => {
		if (!Number.isFinite(seconds)) return;
		if (listenRoom.getSnapshot().role === "guest") {
			sendGuestAction({ type: "seek", position: seconds });
			return;
		}
		const element = videoElementRef.current;
		if (element)
			element.currentTime = Math.max(
				0,
				Math.min(
					seconds,
					Number.isFinite(element.duration) ? element.duration : seconds,
				),
			);
	}, []);
	const prepareRoomTrack = useCallback(
		async (song: Song, songs: Song[], index: number) => {
			setQueueState(songs);
			setCurrentIndex(index);
			await playSong(song, true);
		},
		[playSong],
	);
	const previewRoomTrack = useCallback(
		(song: Song | null, songs: Song[], index: number) => {
			cancelTrackLoad();
			abortCrossfade();
			decksRef.current[activeDeckRef.current].reset();
			setIsPlaying(false);
			setVideoInfo(null);
			setCurrentSong(song);
			setQueueState(songs);
			setCurrentIndex(index);
		},
		[abortCrossfade, cancelTrackLoad],
	);
	const getPlaybackGeneration = useCallback(() => loadRequestRef.current, []);
	const applyRoomQueue = useCallback((songs: Song[], index: number) => {
		setQueueState(songs);
		setCurrentIndex(index);
	}, []);
	const removeAutoplayAt = useCallback((index: number) => {
		if (listenRoom.getSnapshot().role !== "guest")
			setAutoplayTracks((tracks) => tracks.filter((_, i) => i !== index));
	}, []);
	const applyRoomAutoplay = useCallback((songs: Song[]) => {
		setAutoplayTracks(songs);
	}, []);

	useEffect(() => {
		if (roomRole === "host" && roomUsername) {
			setQueueState((songs) => songs.map(attributeLocal));
		}
	}, [roomRole, roomUsername]);

	useEffect(() => {
		if (roomRole) abortCrossfade();
		return () => {
			if (roomRole === "guest") {
				// Detach synchronization without removing the track underneath an
				// open fullscreen player. Keep the queue, position and stream so
				// playback can resume locally, including a track still loading.
				setIsPlaying(false);
				const media = videoElementRef.current;
				media?.pause();
				if (media) media.playbackRate = 1;
			}
		};
	}, [roomRole, abortCrossfade]);

	const enqueue = useCallback(
		(songs: Song[], contributor?: string) => {
			if (!songs.length) return;
			if (!currentSong && queue.length === 0)
				return play(
					attributeLocal({ ...songs[0], addedBy: contributor }),
					songs
						.slice(1)
						.map((song) => attributeLocal({ ...song, addedBy: contributor })),
				);
			else {
				addToQueue(songs, contributor);
				showToast("Added to queue");
			}
		},
		[currentSong, queue.length, play, addToQueue],
	);

	const playerValue = useMemo<PlayerContextType>(
		() => ({
			currentSong,
			currentAlbum: currentTrackMeta?.album ?? null,
			currentTrackMeta,
			play: localControl(play, (song, songs) =>
				songs ? selectionAction([song, ...songs], 0) : { type: "play", song },
			),
			playQueue: localControl(playQueue, selectionAction),
			playingVideoId: videoInfo?.basic_info.id ?? null,
			queue,
			currentIndex,
			autoplayTracks,
			autoplayEnabled,
			upcomingTrack,
			setAutoplayEnabled,
			removeAutoplayAt,
			playAutoplayAt: localControl(playAutoplayAt, (index) => ({
				type: "autoplay",
				index,
				queueKey: queueKey(autoplayTracks.slice(0, SHARED_AUTOPLAY_LIMIT)),
			})),
			addToQueue: localControl(enqueue, (songs) => ({
				type: "add",
				songs: songs.slice(0, SHARED_QUEUE_LIMIT),
			})),
			setQueue: localControl(setQueue, (songs) => {
				const used = new Set<number>();
				return {
					type: "reorder",
					order: songs.map((song) => {
						let index = queue.findIndex(
							(item, i) => item === song && !used.has(i),
						);
						if (index < 0)
							index = queue.findIndex(
								(item, i) => item.id === song.id && !used.has(i),
							);
						used.add(index);
						return index;
					}),
				};
			}),
			playNext: localControl(playNext, (song) => ({ type: "playNext", song })),
			removeFromQueueAt: localControl(removeFromQueueAt, (index) => ({
				type: "remove",
				index,
			})),
			shuffleQueue: localControl(shuffleQueue, () => ({ type: "shuffle" })),
			repeatMode,
			setRepeatMode: localControl(setRepeatMode, (mode) => ({
				type: "repeat",
				mode,
			})),
			next: localControl(
				() => advance("skip"),
				() => ({ type: "next" }),
			),
			previous: localControl(previous, () => ({ type: "previous" })),
			hasNext,
			hasPrevious,
			videoElementRef,
			activeMedia,
			duration: currentDuration,
			seek,
			prepareRoomTrack,
			previewRoomTrack,
			setRoomPlaying: setIsPlaying,
			applyRoomQueue,
			applyRoomAutoplay,
			getPlaybackGeneration,
		}),
		[
			currentSong,
			currentTrackMeta,
			activeMedia,
			play,
			playQueue,
			videoInfo,
			queue,
			currentIndex,
			autoplayTracks,
			autoplayEnabled,
			upcomingTrack,
			setAutoplayEnabled,
			removeAutoplayAt,
			playAutoplayAt,
			enqueue,
			setQueue,
			playNext,
			removeFromQueueAt,
			shuffleQueue,
			repeatMode,
			setRepeatMode,
			advance,
			previous,
			hasNext,
			hasPrevious,
			currentDuration,
			seek,
			prepareRoomTrack,
			previewRoomTrack,
			getPlaybackGeneration,
			applyRoomQueue,
			applyRoomAutoplay,
		],
	);

	const controlsValue = useMemo<PlayerControlsContextType>(
		() => ({
			isPlaying: roomPlaying ?? isPlaying,
			pause: localControl(pause, () => ({ type: "pause" })),
			resume: localControl(resume, () => ({ type: "resume" })),
			toggle: localControl(toggle, () => ({
				type: (roomPlaying ?? isPlaying) ? "pause" : "resume",
			})),
		}),
		[isPlaying, roomPlaying, pause, resume, toggle],
	);

	const volumeValue = useMemo<PlayerVolumeContextType>(
		() => ({ volume, setVolume, toggleMute }),
		[volume, setVolume, toggleMute],
	);

	endedHandlerRef.current = handleEnded;
	return (
		<PlayerContext.Provider value={playerValue}>
			<PlayerControlsContext.Provider value={controlsValue}>
				<PlayerVolumeContext.Provider value={volumeValue}>
					<QueueSheetContext.Provider value={queueSheetRef}>
						{children}
						{/* Two hidden media decks — one plays, the idle one buffers
						    the next track so a crossfade can overlap the two. Both
						    must always be mounted so streams can attach. */}
						{!IS_ANDROID && (
							<>
								<video
									className="pointer-events-none fixed top-0 left-0 h-px w-px opacity-0"
									onEnded={() => handleEnded(0)}
									playsInline
									ref={attachDeckA}
								/>
								<video
									className="pointer-events-none fixed top-0 left-0 h-px w-px opacity-0"
									onEnded={() => handleEnded(1)}
									playsInline
									ref={attachDeckB}
								/>
							</>
						)}
					</QueueSheetContext.Provider>
				</PlayerVolumeContext.Provider>
			</PlayerControlsContext.Provider>
		</PlayerContext.Provider>
	);
}

export function usePlayer() {
	const context = useContext(PlayerContext);
	if (context === undefined) {
		throw new Error("usePlayer must be used within a PlayerProvider");
	}
	return context;
}

/** Play/pause state + controls. Separate so toggling doesn't re-render the app. */
export function usePlayerControls() {
	const context = useContext(PlayerControlsContext);
	if (context === undefined) {
		throw new Error("usePlayerControls must be used within a PlayerProvider");
	}
	return context;
}

/** Volume state + setter. Separate so dragging the slider doesn't re-render the app. */
export function usePlayerVolume() {
	const context = useContext(PlayerVolumeContext);
	if (context === undefined) {
		throw new Error("usePlayerVolume must be used within a PlayerProvider");
	}
	return context;
}

/**
 * Ref to the queue sheet's root element. The swipe-up gesture drives the
 * sheet's transform imperatively through this ref so the panel can follow
 * the finger every frame without re-rendering the (potentially very long)
 * queue list.
 */
const QueueSheetContext = createContext<
	RefObject<HTMLElement | null> | undefined
>(undefined);

export function useQueueSheetRef() {
	return useContext(QueueSheetContext);
}
