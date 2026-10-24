import { convertFileSrc } from "@tauri-apps/api/core";
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
import { Constants } from "youtubei.js";
import type { Innertube, YT } from "youtubei.js/web";
import {
	type DownloadEntry,
	getDownloadEntry,
} from "@/lib/downloads/downloads";
import { LISTEN_GRACE_SECONDS, listeningSession } from "@/lib/player/listening";
import { nextQueueIndex, type RepeatMode } from "@/lib/player/repeat";
import { mountSabrAudio } from "@/lib/player/sabr-audio";
import { shuffleFrom } from "@/lib/player/shuffle";
import { clampCrossfadeSeconds, useSettings } from "@/lib/stores/settings";
import {
	rememberSongVersion,
	songVersionReplacement,
} from "@/lib/stores/song-versions";
import { applySongDescription } from "@/lib/utils/description";
import { MAX_VOLUME } from "@/lib/utils/hooks";
import {
	biggestThumb,
	hiResThumb,
	parseDuration,
	type ThumbCandidate,
} from "@/lib/utils/utils";
import { rememberSongDescription } from "@/lib/youtube/song-description";
import { applySongVersion } from "@/lib/youtube/song-version";
import { isVideoId } from "@/lib/youtube/youtube.utils";
import {
	getAutoplaySongs,
	getPlaybackStream,
	getSongVersion,
	getTrackMeta,
} from "@/lib/youtube/youtube-client";

export interface Song {
	id: string;
	title: string;
	artist: string;
	/** Channel id (UC…) of the primary artist, when known */
	artistId?: string;
	/** All artists with their channel ids, when known */
	artists?: Array<{ name: string; id?: string }>;
	thumbnail: string;
	duration?: string;
	/** Uploader description; its credits refine the title and artist. */
	description?: string;
	/**
	 * Uploader video without a music release behind it (no album). Its title
	 * is the uploader's own string — e.g. "かめりあ - Towards the Horizon" —
	 * and is shown as-is instead of being read as an original/translation
	 * pair. Undefined means "not checked" (normal parsing).
	 */
	upload?: boolean;
	/**
	 * Channel ids for credited names from the description ("Vocal：湊あくあ"
	 * next to a channel link), so featured performers link their artist page
	 * like the primary artist does.
	 */
	creditIds?: Array<{ name: string; id: string }>;
}

/**
 * Playback state/actions. Deliberately does NOT contain the rapidly-changing
 * `isPlaying` or `volume`: those live in their own contexts below so that a
 * play/pause toggle or a volume drag doesn't recreate this value and
 * re-render every consumer (which used to re-render the whole app shell and
 * current page — the source of the input lag on those controls).
 */
interface PlayerContextType {
	currentSong: Song | null;
	play: (song: Song, queue?: Song[]) => void;
	/** Replaces the queue with `songs` and starts playing at `index`. */
	playQueue: (songs: Song[], index: number) => void;
	videoInfo: YT.VideoInfo | null;
	innertube: Innertube | null;
	queue: Song[];
	currentIndex: number;
	/** Upcoming radio tracks shown below the queue's "Autoplay" separator. */
	autoplayTracks: Song[];
	/** Plays an autoplay track, promoting it and its predecessors to the queue. */
	playAutoplayAt: (index: number) => void;
	addToQueue: (songs: Song[]) => void;
	setQueue: (songs: Song[]) => void;
	/** Insert a song directly after the current one without starting it. */
	playNext: (song: Song) => void;
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
	videoContainerRef: RefObject<HTMLDivElement | null> | null;
	videoElementRef: RefObject<HTMLVideoElement | null> | null;
	/**
	 * Authoritative track length in seconds from YouTube metadata (0 when
	 * unknown). Preferred over the media element's duration, whose exact
	 * value is a fraction shorter than the length YouTube reports in
	 * listings — using it made the player show e.g. 2:54 vs the playlist's 2:55.
	 */
	duration: number;
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

/** How often playback reports its watched range to YouTube's stats endpoint. */
const WATCHTIME_PING_MS = 15_000;

// The stats endpoints identify the client that played the song. Report as the
// YouTube Music web player (WEB_REMIX), not plain YouTube, and post to the
// music host — matching music.youtube.com's own playback pings.
const STATS_CLIENT = {
	client_name: Constants.CLIENTS.YTMUSIC.NAME,
	client_version: Constants.CLIENTS.YTMUSIC.VERSION,
};

function musicStatsUrl(url: string): string {
	return url.replace(/^https:\/\/s\.youtube\.com/, "https://music.youtube.com");
}

/**
 * Registers the play with YouTube's playback stats — the same ping the web
 * player sends — so the song lands in the account's watch history.
 */
function reportPlayback(videoInfo: YT.VideoInfo) {
	const tracking = videoInfo.page[0]?.playback_tracking;
	if (!tracking?.videostats_playback_url) return;
	void videoInfo.actions
		.stats(musicStatsUrl(tracking.videostats_playback_url), STATS_CLIENT, {
			cpn: videoInfo.cpn,
			c: STATS_CLIENT.client_name,
			fmt: "251",
			rtn: "0",
			rt: "0",
		})
		.catch((error) => {
			console.warn("[YuMusic] playback ping failed:", error);
		});
}

/**
 * Reports a watched media segment (`[start, end]`) to YouTube's watch-time
 * endpoint — the periodic ping the web player sends so the history entry
 * keeps its resume position. `final` closes the playback session.
 */
function reportWatchTime(
	videoInfo: YT.VideoInfo,
	start: number,
	end: number,
	final: boolean,
) {
	const tracking = videoInfo.page[0]?.playback_tracking;
	if (!tracking?.videostats_watchtime_url) return;
	void videoInfo.actions
		.stats(musicStatsUrl(tracking.videostats_watchtime_url), STATS_CLIENT, {
			cpn: videoInfo.cpn,
			c: STATS_CLIENT.client_name,
			st: start.toFixed(3),
			et: end.toFixed(3),
			cmt: end.toFixed(3),
			final: final ? "1" : "0",
		})
		.catch((error) => {
			console.warn("[YuMusic] watch-time ping failed:", error);
		});
}

/**
 * Seconds before the end of a track at which the next one starts buffering
 * on the idle deck. Generous enough for the metadata request, PoToken and
 * SABR handshake to finish before the fade window opens; a preload that is
 * still not ready when the track ends falls back to the normal load path.
 */
const CROSSFADE_PRELOAD_LEAD_SECONDS = 15;

/**
 * One of the two hidden media elements the player renders and swaps between.
 * The idle deck buffers the next track so a crossfade can overlap the two.
 */
interface Deck {
	/** The hidden media element this deck outputs through. */
	ref: RefObject<HTMLVideoElement | null>;
	/**
	 * Video id mounted on the element (a load in progress counts). Null while
	 * idle; the guard that keeps a crossfade promotion from re-loading the
	 * track that is already mounted.
	 */
	videoId: string | null;
	/** True once audio chunks have been appended and the deck can play. */
	ready: boolean;
	/** Aborts this deck's reader and tears down its MediaSource. */
	stop: (() => void) | null;
	/** Invalidates async work after a teardown or a newer load. */
	generation: number;
}

interface LoadedStream {
	videoInfo: YT.VideoInfo;
	innertube: Innertube;
}

interface MountOptions {
	/** Start playback as soon as the first chunks land (normal loads). */
	autoPlay: boolean;
	/** Called once the deck is buffered enough to play (crossfade preloads). */
	onReady?: () => void;
}

/** Crossfade runtime state; null while no crossfade is in flight. */
interface CrossfadeState {
	phase: "preload" | "fading";
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

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [settings, updateSettings] = useSettings();
	const repeatMode = settings.repeatMode;
	const setRepeatMode = useCallback(
		(mode: RepeatMode) => updateSettings({ repeatMode: mode }),
		[updateSettings],
	);
	const [currentSong, setCurrentSong] = useState<Song | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [videoInfo, setVideoInfo] = useState<YT.VideoInfo | null>(null);
	const [innertube, setInnertube] = useState<Innertube | null>(null);
	const [queue, setQueueState] = useState<Song[]>([]);
	const [currentIndex, setCurrentIndex] = useState(-1);
	const [autoplayTracks, setAutoplayTracks] = useState<Song[]>([]);
	const [history, setHistory] = useState<Song[]>([]);
	const queueSheetRef = useRef<HTMLElement | null>(null);
	const [videoContainerRef] = useState<RefObject<HTMLDivElement> | null>(null);
	const deckARef = useRef<HTMLVideoElement | null>(null);
	const deckBRef = useRef<HTMLVideoElement | null>(null);
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
			{ ref: deckARef, videoId: null, ready: false, stop: null, generation: 0 },
			{ ref: deckBRef, videoId: null, ready: false, stop: null, generation: 0 },
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
	const [volume, _setVolume] = useState(() => {
		const savedVolume = localStorage.getItem("yumusic-volume");
		const parsed = savedVolume ? Number.parseFloat(savedVolume) : NaN;
		return Number.isFinite(parsed)
			? Math.min(MAX_VOLUME, Math.max(0, parsed))
			: MAX_VOLUME;
	});

	/** Read by the fade loop so volume changes mid-fade stay respected. */
	const volumeRef = useRef(volume);
	volumeRef.current = volume;

	// The app reads playback through `videoElementRef`; point it at deck A
	// before any track loads so consumers never hold a stale element.
	useEffect(() => {
		if (!videoElementRef.current) {
			videoElementRef.current = deckARef.current;
		}
	}, []);

	/** Aborts a deck's stream and detaches its media element. Idempotent. */
	const teardownDeck = useCallback((deck: Deck) => {
		deck.generation += 1;
		deck.videoId = null;
		deck.ready = false;
		deck.stop?.();
		deck.stop = null;
		const videoEl = deck.ref.current;
		if (videoEl) {
			videoEl.pause();
			if (videoEl.src) {
				videoEl.removeAttribute("src");
				videoEl.load();
			}
		}
	}, []);

	/**
	 * googlevideo's SabrStream manages the SABR session. Its audio is fed
	 * straight into a MediaSource — the app is audio-only, so there's no
	 * manifest and no Shaka. Buffering is limited to a short window and seeks
	 * outside that window restart SABR at the requested position.
	 *
	 * Mounts onto either deck so the idle one can buffer the next track for
	 * a crossfade while the active one keeps playing.
	 */
	const mountTrack = useCallback(
		async (deck: Deck, result: LoadedStream, options: MountOptions) => {
			const { videoInfo, innertube } = result;
			const videoEl = deck.ref.current;
			const videoId = videoInfo.basic_info.id;
			if (!videoEl || !videoId || !videoInfo.streaming_data) return;
			if (videoInfo.basic_info.is_live || videoInfo.basic_info.is_post_live_dvr)
				return;
			teardownDeck(deck);
			deck.videoId = videoId;
			const generation = deck.generation;
			const controller = new AbortController();
			deck.stop = () => controller.abort();
			if (deck === decksRef.current[activeDeckRef.current])
				videoElementRef.current = videoEl;
			try {
				await mountSabrAudio(videoEl, videoInfo, innertube, {
					signal: controller.signal,
					onReady: () => {
						deck.ready = true;
						if (options.autoPlay) {
							videoEl.volume = volumeRef.current;
							void videoEl.play().catch((error) => {
								if (error.name !== "AbortError")
									console.error("[PlayerContext] Auto-playback failed:", error);
							});
						}
						options.onReady?.();
					},
				});
			} catch (error) {
				if (!controller.signal.aborted && deck.generation === generation) {
					console.error("[PlayerContext] Load video error:", error);
					deck.videoId = null;
					deck.ready = false;
				}
			}
		},
		[teardownDeck],
	);

	/**
	 * Mounts a downloaded audio file onto a deck. Resolves `true` once the
	 * file has metadata (preloads) or playback began (normal loads), and
	 * `false` when the stored file cannot be read, so callers can fall back
	 * to streaming it instead.
	 */
	const mountLocalTrack = useCallback(
		(
			deck: Deck,
			song: Song,
			entry: DownloadEntry,
			options: MountOptions,
		): Promise<boolean> => {
			const videoEl = deck.ref.current;
			if (!videoEl) return Promise.resolve(false);

			teardownDeck(deck);
			deck.generation += 1;
			const generation = deck.generation;
			deck.videoId = song.id;
			if (deck === decksRef.current[activeDeckRef.current]) {
				videoElementRef.current = videoEl;
			}

			return new Promise<boolean>((resolve) => {
				let settled = false;
				const finish = (mounted: boolean) => {
					if (settled) return;
					settled = true;
					videoEl.removeEventListener("error", onError);
					resolve(mounted);
				};
				const onError = () => {
					const mediaError = videoEl.error;
					console.warn(
						"[PlayerContext] Downloaded file failed to play; keeping it for a later retry:",
						entry.path,
						videoEl.src,
						mediaError
							? `media error code ${mediaError.code}`
							: "no media error",
					);
					if (deck.generation === generation) {
						deck.videoId = null;
						deck.ready = false;
					}
					finish(false);
				};

				videoEl.addEventListener("error", onError, { once: true });

				const onLoaded = () => {
					if (deck.generation !== generation) return;
					deck.ready = true;
					options.onReady?.();
				};
				if (videoEl.readyState >= 1) onLoaded();
				else
					videoEl.addEventListener("loadedmetadata", onLoaded, { once: true });

				videoEl.volume = volumeRef.current;
				videoEl.src = convertFileSrc(entry.path);
				videoEl.load();
				if (options.autoPlay) {
					videoEl
						.play()
						.then(() => finish(true))
						.catch((error) => {
							// Pauses and newer loads interrupt play(); only real
							// media failures should trigger the streaming fallback.
							if ((error as Error).name === "AbortError") finish(true);
							else onError();
						});
				} else {
					finish(true);
				}
			});
		},
		[teardownDeck],
	);

	// Load the current track onto the active deck whenever playback state
	// points at a track that deck does not already have mounted. A crossfade
	// promotion mounted its track on the inactive deck beforehand, so this
	// guard also keeps the handover from re-loading it.
	useEffect(() => {
		if (!videoInfo || !innertube) return;
		const deck = decksRef.current[activeDeckRef.current];
		if (!deck || deck.videoId === videoInfo.basic_info.id) return;
		void mountTrack(deck, { videoInfo, innertube }, { autoPlay: true });
	}, [videoInfo, innertube, mountTrack]);

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
		teardownDeck(decksRef.current[state.deckIndex]);
	}, [teardownDeck]);

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
			crossfadeRef.current = null;
			if (crossfadeRafRef.current !== null) {
				cancelAnimationFrame(crossfadeRafRef.current);
				crossfadeRafRef.current = null;
			}

			const oldDeck = decksRef.current[activeDeckRef.current];
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
						entry.id === state.originalId ? state.nextSong : entry,
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
			teardownDeck(oldDeck);
		},
		[teardownDeck],
	);

	/**
	 * Runs the actual overlap: the preloaded deck starts at zero volume and
	 * the two are ramped with equal-power curves over the overlap length.
	 * The ramp follows the audio clock, so throttled frames in a background
	 * window still reach the handover; rAF only smooths the visible steps.
	 */
	const startFade = useCallback(
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
			state.phase = "fading";

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
	const markUpload = useCallback(async (song: Song): Promise<Song> => {
		const meta = await getTrackMeta(song.id).catch(() => null);
		if (!meta || meta.album) return song;
		const mark = (entry: Song): Song =>
			entry.id === song.id ? { ...entry, upload: true } : entry;
		setCurrentSong((prev) => (prev ? mark(prev) : prev));
		setQueueState((prev) => prev.map(mark));
		setAutoplayTracks((prev) => prev.map(mark));
		return { ...song, upload: true };
	}, []);

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
			// Stored files skip the stream session entirely.
			const localEntry = getDownloadEntry(nextSong.id) ?? null;
			if (!localEntry && !isVideoId(nextSong.id)) return;

			const state: CrossfadeState = {
				advance: null,
				deckIndex,
				fromSong,
				localEntry,
				// A stored file carries the description saved with the download.
				nextSong: localEntry?.description
					? applySongDescription(nextSong, localEntry.description)
					: nextSong,
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
				void mountLocalTrack(deck, state.nextSong, localEntry, {
					autoPlay: false,
					onReady: () => updateCrossfadeRef.current(),
				});
				return;
			}

			try {
				const result = await getPlaybackStream(state.nextSong.id);
				if (crossfadeRef.current !== state) return;
				// The stream may be the album track of a music video: the
				// incoming track becomes that song before the handover.
				if (result.videoId !== state.nextSong.id) {
					const version = await getSongVersion(state.nextSong.id);
					if (crossfadeRef.current !== state) return;
					if (version) {
						const played = applySongVersion(state.nextSong, version);
						rememberSongVersion(state.nextSong, played);
						state.nextSong = played;
					}
				}
				// The player response carries the uploader description; keep it
				// and let its credits refine the title/artist before the handover.
				const description =
					result.videoInfo.basic_info.short_description?.trim();
				if (description) {
					rememberSongDescription(state.nextSong.id, description);
					state.nextSong = applySongDescription(state.nextSong, description);
				}
				// Uploader videos without a release keep their raw titles.
				state.nextSong = await markUpload(state.nextSong);
				state.result = {
					videoInfo: result.videoInfo,
					innertube: result.innertube,
				};
				await mountTrack(deck, state.result, {
					autoPlay: false,
					onReady: () => updateCrossfadeRef.current(),
				});
				// If the track is already inside the fade window, start now;
				// otherwise the scheduler fires when the window opens.
				if (crossfadeRef.current === state) updateCrossfadeRef.current();
			} catch (error) {
				// Leave the state in place on failure: the scheduler then
				// stops retrying the same fetch on every timeupdate, and the
				// track's end falls back to the normal load path.
				console.error("[PlayerContext] Crossfade preload failed:", error);
			}
		},
		[markUpload, mountLocalTrack, mountTrack],
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
		const activeEl = decksRef.current[activeDeckRef.current]?.ref.current;
		if (
			!seconds ||
			!isPlaying ||
			!currentSong ||
			!activeEl ||
			repeatMode === "one"
		) {
			abortCrossfade();
			return;
		}

		// The song that will play next, mirroring next(): queue first, then
		// the autoplay radio (whose first track gets promoted to the queue).
		const nextIndex = nextQueueIndex(currentIndex, queue.length, repeatMode);
		const queuedNext = nextIndex !== null ? queue[nextIndex] : null;
		const nextSong =
			queuedNext ?? (settings.autoplay ? (autoplayTracks[0] ?? null) : null);

		const state = crossfadeRef.current;
		// The queue changed under an armed crossfade; re-evaluate from scratch.
		// Compared against the queued id: the state's song may already be the
		// album track of that entry.
		if (
			state &&
			(!nextSong ||
				nextSong.id !== state.originalId ||
				state.nextIndex !== (nextIndex ?? queue.length))
		) {
			abortCrossfade();
		}
		// Replaying a single-entry playlist starts at its natural end.
		if (nextIndex === currentIndex) {
			abortCrossfade();
			return;
		}

		const duration = activeEl.duration;
		if (!Number.isFinite(duration) || duration <= 0) return;
		const remaining = duration - activeEl.currentTime;

		if (!nextSong) return;
		if (remaining > seconds + CROSSFADE_PRELOAD_LEAD_SECONDS) {
			if (crossfadeRef.current) abortCrossfade();
			return;
		}

		const armed = crossfadeRef.current;
		if (!armed) {
			void armCrossfade(
				nextSong,
				queuedNext === null,
				seconds,
				currentSong,
				nextIndex ?? queue.length,
			);
			return;
		}
		// rAF is paused while the window is hidden; timeupdate (which keeps
		// firing during background audio playback) drives the fade then.
		if (armed.phase === "fading") {
			armed.advance?.();
			return;
		}
		const deck = decksRef.current[armed.deckIndex];
		if (
			deck?.ready &&
			(armed.result || armed.localEntry) &&
			remaining <= seconds
		) {
			// Respect a length change made while the preload was buffering.
			armed.seconds = seconds;
			startFade(armed);
		}
	}, [
		settings.crossfade,
		settings.crossfadeSeconds,
		settings.autoplay,
		repeatMode,
		isPlaying,
		currentSong,
		currentIndex,
		queue,
		autoplayTracks,
		abortCrossfade,
		armCrossfade,
		startFade,
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
		localStorage.setItem("yumusic-volume", volume.toString());
	}, [volume]);

	const setVolume = useCallback((next: number) => {
		_setVolume(Math.min(MAX_VOLUME, Math.max(0, next)));
	}, []);

	const playSong = useCallback(
		async (song: Song) => {
			// Any queued crossfade targets the old track; drop it.
			abortCrossfade();
			const request = ++loadRequestRef.current;
			const oldDeck = decksRef.current[activeDeckRef.current];
			if (oldDeck) teardownDeck(oldDeck);
			setIsPlaying(false);
			// A stored file carries the description saved with the download.
			const localEntry = getDownloadEntry(song.id);
			if (localEntry?.description) {
				song = applySongDescription(song, localEntry.description);
			}
			setCurrentSong(song);
			setVideoInfo(null);
			setInnertube(null);

			// A stored file plays straight from disk — no stream session, and
			// no watch-history pings (there is no playback tracker for it).
			if (localEntry) {
				const deck = decksRef.current[activeDeckRef.current];
				const mounted = deck
					? await mountLocalTrack(deck, song, localEntry, { autoPlay: true })
					: false;
				if (request !== loadRequestRef.current) return;
				if (mounted) {
					setIsPlaying(true);
					return;
				}
				// Stream this play instead. The stored file is deliberately
				// kept: deleting it here made kept-downloaded playlists
				// re-download every track on the next visit (mountLocalTrack
				// already logged why it failed). Removal stays a user action.
			}

			try {
				if (!isVideoId(song.id)) {
					throw new Error(
						`Invalid video id "${song.id}" for "${song.title}" — cannot play`,
					);
				}
				const result = await getPlaybackStream(song.id);
				// A newer play request superseded this one while it loaded.
				if (request !== loadRequestRef.current) return;
				if (result) {
					// The stream may be the album track of a music video: the
					// track *is* that song, so adopt its entry everywhere.
					let played = song;
					if (result.videoId !== song.id) {
						const version = await getSongVersion(song.id);
						if (request !== loadRequestRef.current) return;
						if (version) {
							played = applySongVersion(song, version);
							rememberSongVersion(song, played);
							const replace = (entry: Song) =>
								entry.id === song.id ? played : entry;
							setCurrentSong((prev) =>
								prev && prev.id === song.id ? played : prev,
							);
							setQueueState((prev) => prev.map(replace));
							setAutoplayTracks((prev) => prev.map(replace));
						}
					}
					setVideoInfo(result.videoInfo);
					setInnertube(result.innertube);
					setIsPlaying(true);

					// Store the uploader description and apply its credits to
					// every copy of the track on screen (player, queue, radio).
					const basic = result.videoInfo.basic_info;
					const description = basic.short_description?.trim();
					if (description) {
						rememberSongDescription(played.id, description);
						setCurrentSong((prev) =>
							prev && prev.id === played.id
								? applySongDescription(prev, description)
								: prev,
						);
						setQueueState((prev) =>
							prev.map((entry) =>
								entry.id === played.id
									? applySongDescription(entry, description)
									: entry,
							),
						);
						setAutoplayTracks((prev) =>
							prev.map((entry) =>
								entry.id === played.id
									? applySongDescription(entry, description)
									: entry,
							),
						);
					}

					// Upgrade the artwork from the player response (see pickArtwork).
					const thumbnail = pickArtwork(played, basic);
					if (thumbnail) {
						setCurrentSong((prev) =>
							prev && prev.id === played.id ? { ...prev, thumbnail } : prev,
						);
					}

					// Uploader videos without a release keep their raw titles.
					void markUpload(played);
				}
			} catch (error) {
				console.error(
					"[PlayerContext] Failed to play song:",
					error,
					error instanceof Error ? error.stack : undefined,
				);
			}
		},
		[abortCrossfade, markUpload, mountLocalTrack, teardownDeck],
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
	}, [settings.autoplay, autoplaySongId, autoplayTracks.length]);

	const play = useCallback(
		async (song: Song, newQueue?: Song[]) => {
			// The entry may resolve to its album track: match and queue that.
			const target = songVersionReplacement(song.id) ?? song;
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
				setQueueState([target, ...newQueue]);
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
			const song = songs[index];
			if (!song) return;
			// The entry may resolve to its album track: match and queue that.
			const target = songVersionReplacement(song.id) ?? song;
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
			setQueueState(
				song === target
					? songs
					: songs.map((entry) => (entry.id === song.id ? target : entry)),
			);
			setCurrentIndex(index);
			await playSong(target);
		},
		[currentSong, playSong],
	);

	const next = useCallback(async () => {
		const nextIndex = nextQueueIndex(currentIndex, queue.length, repeatMode);
		if (nextIndex === null) {
			// Queue finished: move into the autoplay section. Use the visible
			// suggestions when present, otherwise fetch a mix now.
			if (!currentSong || !settings.autoplay) return;
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
			const nextIndex = nextQueueIndex(
				currentIndex,
				queue.length,
				repeatMode,
				true,
			);
			if (currentSong && (repeatMode === "one" || nextIndex === currentIndex)) {
				listeningSession.reset();
				void playSong(currentSong);
				return;
			}
			const state = crossfadeRef.current;
			if (state?.phase === "fading") {
				// The fade follows the audio clock, so if the track ran out
				// first (or the ramp was throttled), finish the handover now
				// instead of stalling on a paused rAF.
				commitCrossfade(state);
				return;
			}
			setIsPlaying(false);
			void next();
		},
		[
			commitCrossfade,
			next,
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
			for (const deck of decksRef.current) teardownDeck(deck);
		};
	}, [abortCrossfade, teardownDeck]);

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
		(index: number) => {
			const picked = autoplayTracks[index];
			if (!picked) return;
			// Everything up to the picked track joins the user queue above the
			// separator; the rest stays in the autoplay section.
			const promoted = autoplayTracks.slice(0, index + 1);
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

	const addToQueue = useCallback((songs: Song[]) => {
		setQueueState((prev) => [...prev, ...songs]);
	}, []);

	const playNext = useCallback(
		(song: Song) => {
			const insertAt = currentIndex < 0 ? 0 : currentIndex + 1;
			setQueueState((prev) => {
				const next = [...prev];
				next.splice(insertAt, 0, song);
				return next;
			});
		},
		[currentIndex],
	);

	const removeFromQueueAt = useCallback(
		(index: number) => {
			const nextQueue = queue.filter((_, i) => i !== index);
			setQueueState(nextQueue);
			if (index === currentIndex) {
				// Removing the playing entry advances to what now occupies its
				// slot, so audio and highlighted row stay in sync.
				if (nextQueue.length === 0) {
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

	const setQueue = useCallback((songs: Song[]) => {
		setQueueState(songs);
	}, []);

	const pause = useCallback(() => setIsPlaying(false), []);
	const resume = useCallback(() => setIsPlaying(true), []);
	const toggle = useCallback(() => setIsPlaying((playing) => !playing), []);

	const hasNext =
		nextQueueIndex(currentIndex, queue.length, repeatMode) !== null ||
		(settings.autoplay && !!currentSong);
	const hasPrevious =
		currentIndex > 0 ||
		history.length > 0 ||
		(repeatMode === "all" && queue.length > 0);
	const duration =
		parseDuration(currentSong?.duration) || videoInfo?.basic_info.duration || 0;

	const playerValue = useMemo<PlayerContextType>(
		() => ({
			currentSong,
			play,
			playQueue,
			videoInfo,
			innertube,
			queue,
			currentIndex,
			autoplayTracks,
			playAutoplayAt,
			addToQueue,
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
			videoContainerRef,
			videoElementRef,
			duration,
		}),
		[
			currentSong,
			play,
			playQueue,
			videoInfo,
			innertube,
			queue,
			currentIndex,
			autoplayTracks,
			playAutoplayAt,
			addToQueue,
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
			videoContainerRef,
			duration,
		],
	);

	const controlsValue = useMemo<PlayerControlsContextType>(
		() => ({ isPlaying, pause, resume, toggle }),
		[isPlaying, pause, resume, toggle],
	);

	const volumeValue = useMemo<PlayerVolumeContextType>(
		() => ({ volume, setVolume }),
		[volume, setVolume],
	);

	return (
		<PlayerContext.Provider value={playerValue}>
			<PlayerControlsContext.Provider value={controlsValue}>
				<PlayerVolumeContext.Provider value={volumeValue}>
					<QueueSheetContext.Provider value={queueSheetRef}>
						{children}
						{/* Two hidden media decks — one plays, the idle one buffers
						    the next track so a crossfade can overlap the two. Both
						    must always be mounted so streams can attach. */}
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
