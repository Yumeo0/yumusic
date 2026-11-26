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
import type { Innertube, YT } from "youtubei.js/web";
import type { DownloadEntry } from "@/lib/downloads/downloads";
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
	type Deck,
	type LoadedStream,
	mountLocalDeck,
	mountStreamDeck,
	resetDeck,
	waitForDeckData,
} from "@/lib/player/playback-deck";
import { nextQueueIndex, type RepeatMode } from "@/lib/player/repeat";
import {
	SHARED_AUTOPLAY_LIMIT,
	SHARED_QUEUE_LIMIT,
	sharedQueueWindow,
} from "@/lib/player/shared-playback";
import { shuffleFrom } from "@/lib/player/shuffle";
import { sleepTimer, useSleepTimer } from "@/lib/player/sleep-timer";
import {
	findDownloadedTrack,
	resolveStreamTrack,
} from "@/lib/player/track-source";
import { useSystemVolume } from "@/lib/player/use-system-volume";
import {
	DEFAULT_VOLUME,
	MAX_VOLUME,
	volumeForDevice,
} from "@/lib/player/volume";
import {
	clampCrossfadeSeconds,
	getSettings,
	useSettings,
} from "@/lib/stores/settings";
import { songVersionReplacement } from "@/lib/stores/song-versions";
import { showToast } from "@/lib/stores/toast";
import { applySongDescription } from "@/lib/utils/description";
import { IS_ANDROID } from "@/lib/utils/tauri";
import {
	biggestThumb,
	hiResThumb,
	parseDuration,
	type ThumbCandidate,
} from "@/lib/utils/utils";
import { applyArtistCredits } from "@/lib/youtube/artist-credits";
import {
	reportPlayback,
	reportWatchTime,
	WATCHTIME_PING_MS,
} from "@/lib/youtube/watch-history";
import { isVideoId } from "@/lib/youtube/youtube.utils";
import {
	getAutoplaySongs,
	getTrackMeta,
	type TrackMeta,
} from "@/lib/youtube/youtube-client";

/**
 * Playback state/actions. Deliberately does NOT contain the rapidly-changing
 * `isPlaying` or `volume`: those live in their own contexts below so that a
 * play/pause toggle or a volume drag doesn't recreate this value and
 * re-render every consumer (which used to re-render the whole app shell and
 * current page — the source of the input lag on those controls).
 */
interface PlayerContextType {
	currentSong: Song | null;
	/** Album or single release belonging to the current song. */
	currentAlbum: NonNullable<TrackMeta["album"]> | null;
	play: (song: Song, queue?: Song[]) => void;
	/** Replaces the queue with `songs` and starts playing at `index`. */
	playQueue: (songs: Song[], index: number) => void;
	playingVideoId: string | null;
	queue: Song[];
	currentIndex: number;
	/** Upcoming radio tracks shown below the queue's "Autoplay" separator. */
	autoplayTracks: Song[];
	autoplayEnabled: boolean;
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
	videoElementRef: RefObject<HTMLVideoElement | null> | null;
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
 * on the idle deck. Generous enough for the metadata request, PoToken and
 * SABR handshake to finish before the fade window opens; a preload that is
 * still not ready when the track ends falls back to the normal load path.
 */
const CROSSFADE_PRELOAD_LEAD_SECONDS = 15;

/** Crossfade runtime state; null while no crossfade is in flight. */
interface CrossfadeState {
	phase: "preload" | "transitioning" | "failed";
	/** Song that fades in (the track after the current one). */
	nextSong: Song;
	/**
	 * Id `nextSong` was queued under; it changes when the track is swapped
	 * for its song version, and stays the queue/action key.
	 */
	originalId: string;
	/** Song that fades out; committed to history on completion. */
	fromSong: Song;
	/** Deck the next song is buffered on (always the idle one). */
	deckIndex: number;
	/** Stream metadata once the preload has finished fetching. */
	result: LoadedStream | null;
	/** Set instead of `result` when the next song plays from a stored file. */
	localEntry: DownloadEntry | null;
	/** Overlap length in seconds, captured when the preload was armed. */
	seconds: number;
	/** Time the outgoing deck reported its natural end during the handover. */
	endedAt?: number;
	/** Next song comes from the autoplay radio and gets promoted to the queue. */
	promote: boolean;
	/** Queue position to select, including a playlist wrap to zero. */
	nextIndex: number;
	/**
	 * Advances the ramp one step. Called by rAF while the window renders and
	 * again on every timeupdate, so a backgrounded window (where rAF is
	 * paused) still completes the fade on the audio clock.
	 */
	advance: (() => void) | null;
}

/**
 * Picks the artwork for a playing track from its player response. YT Music's
 * square cover (googleusercontent) is kept — it is the clean artwork — and
 * other sources take the biggest variant, center-cut to a square for music
 * (googleusercontent URLs get a server-side crop, ytimg ones are cropped by
 * the square containers' object-fit).
 */
function pickArtwork(
	song: Song,
	basic: { category?: string | null; thumbnail?: readonly ThumbCandidate[] },
): string | null {
	const best = biggestThumb(basic.thumbnail);
	if (!best) return null;
	return /googleusercontent\.com|ggpht\.com/.test(song.thumbnail)
		? hiResThumb(song.thumbnail, 1024)
		: basic.category === "Music"
			? hiResThumb(best.url)
			: best.url;
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
	const [trackAlbum, setTrackAlbum] = useState<{
		songId: string;
		album: NonNullable<TrackMeta["album"]> | null;
	} | null>(null);
	const currentSongId = currentSong?.id;
	// Key the result by song id so a late response can never label the next track.
	const currentAlbum =
		trackAlbum?.songId === currentSongId ? (trackAlbum?.album ?? null) : null;
	useEffect(() => {
		if (!currentSongId) return;
		let cancelled = false;
		void getTrackMeta(currentSongId)
			.catch(() => null)
			.then((meta) => {
				if (!cancelled) {
					setTrackAlbum({ songId: currentSongId, album: meta?.album ?? null });
					if (meta?.artists.length) {
						const enrich = (song: Song) =>
							song.id === currentSongId
								? applyArtistCredits(song, meta.artists)
								: song;
						setCurrentSong((song) => (song ? enrich(song) : song));
						setQueueState((songs) => songs.map(enrich));
					}
				}
			});
		return () => {
			cancelled = true;
		};
	}, [currentSongId]);
	const [isPlaying, setIsPlaying] = useState(false);
	const [videoInfo, setVideoInfo] = useState<YT.VideoInfo | null>(null);
	const [innertube, setInnertube] = useState<Innertube | null>(null);
	const [queue, setQueueState] = useState<Song[]>([]);
	const [currentIndex, setCurrentIndex] = useState(-1);
	const [autoplayTracks, setAutoplayTracks] = useState<Song[]>([]);
	const [history, setHistory] = useState<Song[]>([]);
	const queueSheetRef = useRef<HTMLElement | null>(null);
	const deckARef = useRef<HTMLVideoElement | null>(null);
	const deckBRef = useRef<HTMLVideoElement | null>(null);
	const endedHandlerRef = useRef<(index: number) => void>(() => undefined);
	/**
	 * The deck owning playback. Flipped when a crossfade completes (the
	 * preloaded deck becomes active), which is also when `videoElementRef`
	 * is repointed so every consumer follows the new element.
	 */
	const activeDeckRef = useRef(0);
	/** Element the app reads through `videoElementRef`; tracks the active deck. */
	const videoElementRef = useRef<HTMLVideoElement | null>(null);
	const decksRef = useRef<Deck[]>([]);
	if (decksRef.current.length === 0) {
		decksRef.current = [
			{ ref: deckARef, videoId: null, ready: false, mount: null },
			{ ref: deckBRef, videoId: null, ready: false, mount: null },
		];
	}
	const crossfadeRef = useRef<CrossfadeState | null>(null);
	const crossfadeRafRef = useRef<number | null>(null);
	/** Latest crossfade scheduler; async preload completions call through it. */
	const updateCrossfadeRef = useRef<() => void>(() => undefined);
	/** Invalidates a `playSong` request superseded by a newer one. */
	const loadRequestRef = useRef(0);
	const autoplayLoadingRef = useRef(false);
	/** Video id the current autoplay suggestions were fetched for. */
	const autoplayForRef = useRef<string | null>(null);
	const [preferredVolume, _setVolume] = useState(() => {
		const savedVolume = localStorage.getItem("yumusic-volume");
		const parsed = savedVolume ? Number.parseFloat(savedVolume) : NaN;
		return Number.isFinite(parsed)
			? Math.min(MAX_VOLUME, Math.max(0, parsed))
			: DEFAULT_VOLUME;
	});
	const volume = volumeForDevice(preferredVolume, systemVolume);

	/** Read by the fade loop so volume changes mid-fade stay respected. */
	const getVolume = useCallback(() => volumeRef.current, []);
	const volumeRef = useRef(volume);
	volumeRef.current = volume;

	useEffect(() => {
		if (!IS_ANDROID) return;
		const elements = [new NativeAudioElement(0), new NativeAudioElement(1)];
		elements.forEach((element, index) => {
			decksRef.current[index].ref.current =
				element as unknown as HTMLVideoElement;
			element.addEventListener("ended", () => endedHandlerRef.current(index));
		});
		videoElementRef.current =
			decksRef.current[activeDeckRef.current].ref.current;
		return () => {
			for (const element of elements) element.dispose();
		};
	}, []);

	// The app reads playback through `videoElementRef`; point it at deck A
	// before any track loads so consumers never hold a stale element.
	useEffect(() => {
		if (!videoElementRef.current) {
			videoElementRef.current = deckARef.current;
		}
	}, []);

	// Load the current track onto the active deck whenever playback state
	// points at a track that deck does not already have mounted. A crossfade
	// promotion mounted its track on the inactive deck beforehand, so this
	// guard also keeps the handover from re-loading it.
	useEffect(() => {
		if (!videoInfo || !innertube) return;
		const deck = decksRef.current[activeDeckRef.current];
		if (!deck || deck.videoId === videoInfo.basic_info.id) return;
		void mountStreamDeck(
			deck,
			{ videoInfo, innertube },
			{
				autoPlay: isPlaying && listenRoom.getSnapshot().role !== "guest",
				volume: getVolume,
			},
		);
	}, [videoInfo, innertube, isPlaying, getVolume]);

	/** Stops any in-flight crossfade and frees the preloaded deck. */
	const abortCrossfade = useCallback(() => {
		const state = crossfadeRef.current;
		if (!state) return;
		crossfadeRef.current = null;
		if (crossfadeRafRef.current !== null) {
			cancelAnimationFrame(crossfadeRafRef.current);
			crossfadeRafRef.current = null;
		}
		// The fade may have dimmed the still-playing deck; restore its level.
		const activeEl = decksRef.current[activeDeckRef.current]?.ref.current;
		if (activeEl) activeEl.volume = volumeRef.current;
		resetDeck(decksRef.current[state.deckIndex]);
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

	/**
	 * Hands playback from the fading track to the preloaded one: flips the
	 * active deck, advances the queue (promoting an autoplay track when the
	 * fade reaches into the radio), and frees the old deck.
	 */
	const commitCrossfade = useCallback(
		(state: CrossfadeState) => {
			const nextEl = decksRef.current[state.deckIndex]?.ref.current;
			if (
				crossfadeRef.current !== state ||
				(!state.result && !state.localEntry) ||
				!nextEl
			) {
				return;
			}
			const oldDeck = decksRef.current[activeDeckRef.current];
			// A timer changed during the fade. Finish the outgoing song at full gain.
			if (
				!oldDeck.ref.current?.ended &&
				sleepTimer.shouldStopAtTrackEnd(
					currentIndex,
					queue.length,
					state.endedAt,
				)
			) {
				abortCrossfade();
				return;
			}
			if (stopForSleepTimer(state.endedAt)) return;
			crossfadeRef.current = null;
			if (crossfadeRafRef.current !== null) {
				cancelAnimationFrame(crossfadeRafRef.current);
				crossfadeRafRef.current = null;
			}

			activeDeckRef.current = state.deckIndex;
			// Repoint the shared media ref so progress, watch-history and the
			// OS media session follow the element that is now audible.
			videoElementRef.current = nextEl;
			nextEl.volume = volumeRef.current;

			setHistory((prev) => [...prev.slice(-99), state.fromSong]);
			setCurrentIndex(state.nextIndex);
			if (state.promote) {
				setQueueState((prev) => [...prev, state.nextSong]);
				setAutoplayTracks((prev) => prev.slice(1));
			} else if (state.nextSong.id !== state.originalId) {
				// The preload swapped the track for its song version: the
				// queue entry takes over so the current row stays consistent.
				setQueueState((prev) =>
					prev.map((entry) =>
						entry.id === state.originalId
							? { ...state.nextSong, addedBy: entry.addedBy }
							: entry,
					),
				);
			}

			// A stored file carries its own artwork; a streamed preload gets
			// the artwork upgraded from the player response.
			const thumbnail = state.result
				? pickArtwork(state.nextSong, state.result.videoInfo.basic_info)
				: (state.localEntry?.thumbnail ?? null);
			setCurrentSong(
				thumbnail ? { ...state.nextSong, thumbnail } : state.nextSong,
			);
			if (state.result) {
				setVideoInfo(state.result.videoInfo);
				setInnertube(state.result.innertube);
			} else {
				setVideoInfo(null);
				setInnertube(null);
			}
			setIsPlaying(true);

			// The old track is done; free its stream and media element.
			resetDeck(oldDeck);
		},
		[abortCrossfade, currentIndex, queue.length, stopForSleepTimer],
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
				(!state.result && !state.localEntry) ||
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
					resetDeck(decksRef.current[state.deckIndex]);
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

	/**
	 * Marks a track as an uploader video (no music release behind it) on every
	 * copy on screen; such titles are the uploader's own string and are shown
	 * as-is. Resolves to the marked song for the caller's own copy.
	 */
	const markUpload = useCallback(
		async (song: Song, isCurrent: () => boolean): Promise<Song> => {
			const meta = await getTrackMeta(song.id).catch(() => null);
			if (!isCurrent() || !meta || meta.album) return song;
			const mark = (entry: Song): Song =>
				entry.id === song.id ? { ...entry, upload: true } : entry;
			setCurrentSong((prev) => (prev ? mark(prev) : prev));
			setQueueState((prev) => prev.map(mark));
			setAutoplayTracks((prev) => prev.map(mark));
			return { ...song, upload: true };
		},
		[],
	);

	/**
	 * Buffers `nextSong` on the idle deck so it is ready to fade in. Called
	 * once the active track enters the preload window; everything is torn
	 * down again if the fade never happens (skip, seek, pause, queue edit).
	 */
	const armCrossfade = useCallback(
		async (
			nextSong: Song,
			promote: boolean,
			seconds: number,
			fromSong: Song,
			nextIndex: number,
		) => {
			if (crossfadeRef.current) return;
			const deckIndex = activeDeckRef.current === 0 ? 1 : 0;
			const deck = decksRef.current[deckIndex];
			if (!deck) return;
			const local = findDownloadedTrack(nextSong);
			const localEntry = local?.entry ?? null;
			if (!localEntry && !isVideoId(nextSong.id)) return;

			const state: CrossfadeState = {
				advance: null,
				deckIndex,
				fromSong,
				localEntry,
				nextSong: local?.song ?? nextSong,
				originalId: nextSong.id,
				phase: "preload",
				promote,
				nextIndex,
				result: null,
				seconds,
			};
			crossfadeRef.current = state;

			if (localEntry) {
				// The idle deck just needs the file's metadata; the scheduler
				// starts the fade once the window opens.
				void mountLocalDeck(deck, state.nextSong, localEntry, {
					autoPlay: false,
					volume: getVolume,
					onReady: () => updateCrossfadeRef.current(),
				});
				return;
			}

			try {
				const isCurrent = () => crossfadeRef.current === state;
				const { stream, song } = await resolveStreamTrack(nextSong, {
					isCurrent,
				});
				state.nextSong = await markUpload(song, isCurrent);
				if (!isCurrent()) return;
				state.result = stream;
				await mountStreamDeck(deck, state.result, {
					autoPlay: false,
					volume: getVolume,
					onReady: () => updateCrossfadeRef.current(),
				});
				// If the track is already inside the fade window, start now;
				// otherwise the scheduler fires when the window opens.
				if (crossfadeRef.current === state) updateCrossfadeRef.current();
			} catch (error) {
				// Leave the state in place on failure: the scheduler then
				// stops retrying the same fetch on every timeupdate, and the
				// track's end falls back to the normal load path.
				if (crossfadeRef.current === state)
					console.error("[PlayerContext] Crossfade preload failed:", error);
			}
		},
		[markUpload, getVolume],
	);

	const nextTransitionTrack = useCallback(
		(finishQueue: boolean) => {
			if (!finishQueue && repeatMode === "one") return null;
			const index = nextQueueIndex(
				currentIndex,
				queue.length,
				finishQueue ? "off" : repeatMode,
				true,
			);
			if (index === currentIndex) return null;
			if (index !== null) return { song: queue[index], index, promote: false };
			const song = !finishQueue && settings.autoplay ? autoplayTracks[0] : null;
			return song ? { song, index: queue.length, promote: true } : null;
		},
		[currentIndex, queue, repeatMode, settings.autoplay, autoplayTracks],
	);

	/**
	 * Crossfade scheduler, called on every timeupdate of the active deck and
	 * whenever playback, the queue or the settings change. Preloads the
	 * upcoming song once the track nears its end, starts the fade inside the
	 * window, and aborts everything when the target changes.
	 */
	const updateCrossfade = useCallback(() => {
		const seconds = settings.crossfade
			? clampCrossfadeSeconds(settings.crossfadeSeconds)
			: 0;
		const preloadWithoutFade = IS_ANDROID && activeSleepTimer !== null;
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
			(!seconds && !preloadWithoutFade) ||
			!target ||
			sleepTimer.shouldStopAtTrackEnd(currentIndex, queue.length)
		) {
			abortCrossfade();
			return;
		}

		// The queue changed under an armed crossfade; re-evaluate from scratch.
		// Compared against the queued id: the state's song may already be the
		// album track of that entry.
		if (
			state &&
			(target.song.id !== state.originalId ||
				state.nextIndex !== target.index ||
				state.promote !== target.promote)
		) {
			abortCrossfade();
		}

		const duration = activeEl.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;
		const remaining = duration - activeEl.currentTime;

		if (remaining > seconds + CROSSFADE_PRELOAD_LEAD_SECONDS) {
			if (crossfadeRef.current) abortCrossfade();
			return;
		}

		const armed = crossfadeRef.current;
		if (!armed) {
			void armCrossfade(
				target.song,
				target.promote,
				seconds,
				currentSong,
				target.index,
			);
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
			(armed.result || armed.localEntry) &&
			remaining <= seconds
		) {
			// Respect a length change made while the preload was buffering.
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

	// Attach the scheduler to the active deck; re-attaching when the song,
	// queue or settings change also re-evaluates the crossfade immediately.
	useEffect(() => {
		updateCrossfade();
		const videoEl = decksRef.current[activeDeckRef.current]?.ref.current;
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
	}, [updateCrossfade, abortCrossfade]);

	// Watch-time pings: report the played ranges while listening so the entry
	// in YouTube's watch history keeps its resume position. The media element
	// is shared across tracks, so positions are tracked in a closure and the
	// final segment is flushed when the track changes or the player unmounts.
	useEffect(() => {
		if (!settings.watchHistory || !videoInfo) return;
		const videoEl = videoElementRef.current;
		if (!videoEl) return;

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
	}, [settings.watchHistory, videoInfo]);

	// Play/pause control
	useEffect(() => {
		const videoEl = videoElementRef.current;
		if (!videoEl) return;

		// Only control playback if we have a loaded video
		if (videoEl.readyState < 2) {
			return;
		}

		if (isPlaying) {
			videoEl.play().catch((e) => {
				// Ignore AbortError as it's expected when pause is called
				if (e.name !== "AbortError") {
					console.error("Playback failed", e);
				}
			});
		} else {
			videoEl.pause();
		}
	}, [isPlaying]);

	// Mirror the element's real playback state back into React: OS/headset
	// media keys pause the element directly, bypassing setIsPlaying — without
	// this the UI shows "playing" while audio is paused and the play button
	// needs two clicks to resume. Only the active deck counts: the idle one
	// is paused and torn down around crossfades and must not flip the UI.
	useEffect(() => {
		const elements = [deckARef.current, deckBRef.current].filter(
			(el): el is HTMLVideoElement => el !== null,
		);
		const sync = (event: Event) => {
			const el = event.currentTarget as HTMLVideoElement;
			if (el !== videoElementRef.current) return;
			setIsPlaying(!el.paused);
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

	// Volume control - applied to the media element and persisted
	useEffect(() => {
		const videoEl = videoElementRef.current;
		if (videoEl) {
			videoEl.volume = volume;
		}
		if (!systemVolume)
			localStorage.setItem("yumusic-volume", volume.toString());
	}, [volume, systemVolume]);

	const setVolume = useCallback(
		(next: number) => {
			if (!systemVolume) _setVolume(volumeForDevice(next, false));
		},
		[systemVolume],
	);

	const playSong = useCallback(
		async (song: Song, exact = false) => {
			// Any queued crossfade targets the old track; drop it.
			abortCrossfade();
			const request = ++loadRequestRef.current;
			const oldDeck = decksRef.current[activeDeckRef.current];
			if (oldDeck) resetDeck(oldDeck);
			setIsPlaying(false);
			// A stored file carries the description saved with the download.
			const isCurrent = () => request === loadRequestRef.current;
			const local = findDownloadedTrack(song);
			if (local) song = local.song;
			setCurrentSong(song);
			setVideoInfo(null);
			setInnertube(null);

			// A stored file plays straight from disk — no stream session, and
			// no watch-history pings (there is no playback tracker for it).
			if (local) {
				const deck = decksRef.current[activeDeckRef.current];
				const mounted = deck
					? await mountLocalDeck(deck, song, local.entry, {
							autoPlay: !exact,
							volume: getVolume,
						})
					: false;
				if (request !== loadRequestRef.current) return;
				if (mounted && deck) {
					if (exact) await waitForDeckData(deck);
					if (isCurrent()) setIsPlaying(!exact);
					return;
				}
				// Stream this play instead. The stored file is deliberately
				// kept: deleting it here made kept-downloaded playlists
				// re-download every track on the next visit (mountLocalTrack
				// already logged why it failed). Removal stays a user action.
			}

			try {
				const {
					stream,
					song: played,
					description,
				} = await resolveStreamTrack(song, { exact, isCurrent });
				if (!isCurrent()) return;

				if (played.id !== song.id || description) {
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
				const thumbnail = pickArtwork(played, stream.videoInfo.basic_info);
				setCurrentSong((previous) => {
					const current =
						previous?.id === played.id
							? description
								? applySongDescription(previous, description)
								: previous
							: played;
					return thumbnail ? { ...current, thumbnail } : current;
				});
				setVideoInfo(stream.videoInfo);
				setInnertube(stream.innertube);
				setIsPlaying(!exact);
				void markUpload(played, isCurrent);
				if (exact) {
					const deck = decksRef.current[activeDeckRef.current];
					void mountStreamDeck(deck, stream, {
						autoPlay: false,
						volume: getVolume,
					});
					await waitForDeckData(deck);
				}
			} catch (error) {
				if (!isCurrent()) return;
				console.error(
					"[PlayerContext] Failed to play song:",
					error,
					error instanceof Error ? error.stack : undefined,
				);
				if (exact) throw error;
			}
		},
		[abortCrossfade, getVolume, markUpload],
	);

	// Feed the shared listening-session tracker: one tick per second while
	// playing. It defines the grace period both the watch-history ping and
	// ListenBrainz use, and the scrobble threshold.
	useEffect(() => {
		if (!currentSong || !isPlaying) return;
		const videoEl = videoElementRef.current;
		// The element's length can still be unknown right after mounting
		// (MediaSource metadata); the track's listed length fills in so the
		// scrobble threshold is right from the start.
		const elementDuration =
			videoEl && Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
		const listedDuration =
			parseDuration(currentSong.duration) ||
			videoInfo?.basic_info.duration ||
			0;
		listeningSession.start(currentSong.id, elementDuration || listedDuration);
		const timer = window.setInterval(() => {
			if (videoEl && Number.isFinite(videoEl.duration)) {
				listeningSession.setDuration(videoEl.duration);
			}
			listeningSession.tick(1);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [currentSong, isPlaying, videoInfo]);

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

	// Keep the queue's autoplay section stocked: whenever the current track
	// changes and no suggestions are pending, fetch the radio mix for it. The
	// list refills once its tracks have been consumed, giving endless radio.
	// Keyed on the song id, not the object: the thumbnail swap mid-playback
	// replaces `currentSong` with a new object, which would otherwise cancel
	// the in-flight fetch and then block the retry for the same id.
	const autoplaySongId = currentSong?.id ?? null;
	useEffect(() => {
		if (roomRole === "guest") return;
		if (!settings.autoplay || !autoplaySongId) {
			setAutoplayTracks([]);
			autoplayForRef.current = null;
			return;
		}
		if (autoplayTracks.length > 0 || autoplayLoadingRef.current) return;
		if (autoplayForRef.current === autoplaySongId) return;
		autoplayForRef.current = autoplaySongId;
		let cancelled = false;
		autoplayLoadingRef.current = true;
		getAutoplaySongs(autoplaySongId)
			.then((tracks) => {
				if (!cancelled) setAutoplayTracks(tracks);
			})
			.finally(() => {
				if (!cancelled) autoplayLoadingRef.current = false;
			});
		return () => {
			cancelled = true;
			autoplayLoadingRef.current = false;
		};
	}, [roomRole, settings.autoplay, autoplaySongId, autoplayTracks.length]);

	const play = useCallback(
		async (song: Song, newQueue?: Song[]) => {
			// The entry may resolve to its album track: match and queue that.
			const target = attributeLocal({
				...(songVersionReplacement(song.id) ?? song),
				addedBy: song.addedBy,
			});
			if (currentSong?.id === target.id) {
				setIsPlaying(true);
				return;
			}

			// Add current song to history if it exists
			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}

			// A fresh start gets a fresh radio: drop the old track's suggestions
			// so the effect below refetches for the new current song.
			setAutoplayTracks([]);
			autoplayForRef.current = null;

			// If a new queue is provided, add the current song to the front and set it
			if (newQueue) {
				setQueueState([target, ...newQueue.map(attributeLocal)]);
				setCurrentIndex(0);
			} else {
				// Find the song in the existing queue
				const index = queue.findIndex((s) => s.id === target.id);
				if (index !== -1) {
					setCurrentIndex(index);
				} else {
					// Song not in queue, add it to the front
					setQueueState([target, ...queue]);
					setCurrentIndex(0);
				}
			}

			await playSong(target);
		},
		[currentSong, queue, playSong],
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
				setIsPlaying(true);
				return;
			}
			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}
			// A fresh start gets a fresh radio (same as `play`).
			setAutoplayTracks([]);
			autoplayForRef.current = null;
			setQueueState(songs.map((entry, i) => (i === index ? target : entry)));
			setCurrentIndex(index);
			await playSong(target);
		},
		[currentSong, playSong],
	);

	const next = useCallback(async () => {
		const queueTimer = sleepTimer.getSnapshot()?.mode === "queue";
		const nextIndex = nextQueueIndex(
			currentIndex,
			queue.length,
			queueTimer ? "off" : repeatMode,
		);
		if (queueTimer && nextIndex === null) return;
		if (nextIndex === null) {
			// Queue finished: move into the autoplay section. Use the visible
			// suggestions when present, otherwise fetch a mix now.
			if (!currentSong || !settings.autoplay) return;
			const request = loadRequestRef.current;
			let upcoming = autoplayTracks;
			if (upcoming.length === 0) {
				if (autoplayLoadingRef.current) return;
				autoplayLoadingRef.current = true;
				try {
					upcoming = await getAutoplaySongs(currentSong.id);
				} finally {
					autoplayLoadingRef.current = false;
				}
				if (upcoming.length === 0) return;
			}
			// A queue toggle or track change can happen while radio is loading.
			if (
				!getSettings().autoplay ||
				request !== loadRequestRef.current ||
				sleepTimer.getSnapshot()?.mode === "queue"
			)
				return;
			const [upNext, ...rest] = upcoming;
			setAutoplayTracks(rest);
			const extended = [...queue, upNext];
			setQueueState(extended);
			setHistory((prev) => [...prev.slice(-99), currentSong]);
			const nextIndex = currentIndex + 1;
			setCurrentIndex(nextIndex);
			await playSong(upNext);
			return;
		}

		const nextSong = queue[nextIndex];

		// Add current song to history
		if (currentSong) {
			setHistory((prev) => [...prev.slice(-99), currentSong]);
		}

		setCurrentIndex(nextIndex);
		await playSong(nextSong);
	}, [
		currentIndex,
		queue,
		currentSong,
		settings.autoplay,
		repeatMode,
		playSong,
		autoplayTracks,
	]);

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
				IS_ANDROID &&
				!guest &&
				state?.phase === "preload" &&
				!sleepTimer.shouldStopAtTrackEnd(currentIndex, queue.length, endedAt)
			) {
				const target = nextTransitionTrack(queueTimer);
				const deck = decksRef.current[state.deckIndex];
				if (
					target?.song.id === state.originalId &&
					target.index === state.nextIndex &&
					target.promote === state.promote &&
					deck.ready &&
					(state.result || state.localEntry)
				) {
					state.seconds = 0;
					state.endedAt = endedAt;
					startTransition(state);
					return;
				}
			}
			if (stopForSleepTimer(state?.endedAt ?? endedAt) || guest) return;
			const nextIndex = nextQueueIndex(
				currentIndex,
				queue.length,
				queueTimer ? "off" : repeatMode,
				true,
			);
			if (
				!queueTimer &&
				currentSong &&
				(repeatMode === "one" || nextIndex === currentIndex)
			) {
				listeningSession.reset();
				void playSong(currentSong);
				return;
			}
			setIsPlaying(false);
			void next();
		},
		[
			commitCrossfade,
			next,
			nextTransitionTrack,
			startTransition,
			stopForSleepTimer,
			currentIndex,
			queue.length,
			repeatMode,
			currentSong,
			playSong,
		],
	);

	// The provider owns both decks; free their streams when it goes away.
	useEffect(() => {
		return () => {
			abortCrossfade();
			for (const deck of decksRef.current) resetDeck(deck);
		};
	}, [abortCrossfade]);

	const previous = useCallback(async () => {
		// Try to go back in queue first
		if (currentIndex > 0 || (repeatMode === "all" && queue.length > 0)) {
			const prevIndex = currentIndex > 0 ? currentIndex - 1 : queue.length - 1;
			const prevSong = queue[prevIndex];

			// Add current song to history
			if (currentSong) {
				setHistory((prev) => [...prev.slice(-99), currentSong]);
			}

			setCurrentIndex(prevIndex);
			await playSong(prevSong);
			return;
		}

		// Otherwise, use history
		if (history.length === 0) return;

		const previousSong = history[history.length - 1];
		const newHistory = history.slice(0, -1);

		// Add current song to the front of the queue
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
					loadRequestRef.current++;
					setIsPlaying(false);
					setCurrentSong(null);
					setVideoInfo(null);
					setInnertube(null);
					const deck = decksRef.current[activeDeckRef.current];
					if (deck) resetDeck(deck);
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
		[queue, currentIndex, playSong],
	);

	const shuffleQueue = useCallback(() => {
		// Shuffle only what comes after the current song: the playing entry
		// keeps its slot, the played part stays put, and the next track is
		// picked from a fresh random order.
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
	const resume = useCallback(() => {
		// Remote-only guests keep track metadata without a loaded stream.
		// Once they leave the room, Play should start that track locally.
		if (currentSong && !videoInfo && !videoElementRef.current?.readyState) {
			void playSong(currentSong);
			return;
		}
		setIsPlaying(true);
	}, [currentSong, videoInfo, playSong]);
	const toggle = useCallback(() => {
		if (isPlaying) pause();
		else resume();
	}, [isPlaying, pause, resume]);

	const hasNext =
		nextQueueIndex(currentIndex, queue.length, repeatMode) !== null ||
		(autoplayEnabled && !!currentSong);
	const hasPrevious =
		currentIndex > 0 ||
		history.length > 0 ||
		(repeatMode === "all" && queue.length > 0);
	const duration =
		parseDuration(currentSong?.duration) || videoInfo?.basic_info.duration || 0;

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
			loadRequestRef.current++;
			abortCrossfade();
			resetDeck(decksRef.current[activeDeckRef.current]);
			setIsPlaying(false);
			setVideoInfo(null);
			setInnertube(null);
			setCurrentSong(song);
			setQueueState(songs);
			setCurrentIndex(index);
		},
		[abortCrossfade],
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
			currentAlbum,
			play: localControl(play, (song, songs) =>
				songs ? selectionAction([song, ...songs], 0) : { type: "play", song },
			),
			playQueue: localControl(playQueue, selectionAction),
			playingVideoId: videoInfo?.basic_info.id ?? null,
			queue,
			currentIndex,
			autoplayTracks,
			autoplayEnabled,
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
			next: localControl(next, () => ({ type: "next" })),
			previous: localControl(previous, () => ({ type: "previous" })),
			hasNext,
			hasPrevious,
			videoElementRef,
			duration,
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
			currentAlbum,
			play,
			playQueue,
			videoInfo,
			queue,
			currentIndex,
			autoplayTracks,
			autoplayEnabled,
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
			next,
			previous,
			hasNext,
			hasPrevious,
			duration,
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
		() => ({ volume, setVolume }),
		[volume, setVolume],
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
									ref={deckARef}
								/>
								<video
									className="pointer-events-none fixed top-0 left-0 h-px w-px opacity-0"
									onEnded={() => handleEnded(1)}
									playsInline
									ref={deckBRef}
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
