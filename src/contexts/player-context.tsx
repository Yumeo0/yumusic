import { SabrStream } from "googlevideo/sabr-stream";
import { buildSabrFormat, EnabledTrackTypes } from "googlevideo/utils";
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
import { LISTEN_GRACE_SECONDS, listeningSession } from "@/lib/player/listening";
import { useSettings } from "@/lib/stores/settings";
import { MAX_VOLUME } from "@/lib/utils/hooks";
import { biggestThumb, hiResThumb, parseDuration } from "@/lib/utils/utils";
import { botguardService } from "@/lib/youtube/botguard-service";
import { isVideoId } from "@/lib/youtube/youtube.utils";
import {
	fetchFunction,
	getAutoplaySongs,
	getSongStream,
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

/** Appends one media chunk and resolves once the SourceBuffer is ready again. */
function appendToSourceBuffer(
	sourceBuffer: SourceBuffer,
	data: Uint8Array,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			sourceBuffer.removeEventListener("updateend", onUpdateEnd);
			sourceBuffer.removeEventListener("error", onError);
		};
		const onUpdateEnd = () => {
			cleanup();
			resolve();
		};
		const onError = () => {
			cleanup();
			reject(new Error("SourceBuffer append failed"));
		};
		sourceBuffer.addEventListener("updateend", onUpdateEnd);
		sourceBuffer.addEventListener("error", onError);
		try {
			sourceBuffer.appendBuffer(data as unknown as BufferSource);
		} catch (error) {
			cleanup();
			reject(error as Error);
		}
	});
}

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

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [settings] = useSettings();
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
	const videoElementRef = useRef<HTMLVideoElement>(null);
	const sabrStreamRef = useRef<SabrStream | null>(null);
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

	// Load video when videoInfo changes
	useEffect(() => {
		if (!videoInfo || !innertube) return;
		const videoEl = videoElementRef.current;
		if (!videoEl) return;

		const videoId = videoInfo.basic_info.id;
		if (!videoId || !videoInfo.streaming_data) return;
		if (videoInfo.basic_info.is_live || videoInfo.basic_info.is_post_live_dvr) {
			console.warn("[PlayerContext] Live streams are not supported yet.");
			return;
		}
		const streamingData = videoInfo.streaming_data;
		const decipher = async (url?: string) =>
			(await innertube.session.player?.decipher(url)) as string;

		let cancelled = false;
		let objectUrl: string | null = null;
		let mediaSource: MediaSource | null = null;
		let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

		const client = innertube.session.context.client;
		const ustreamerConfig =
			videoInfo.player_config?.media_common_config
				.media_ustreamer_request_config?.video_playback_ustreamer_config;
		const clientInfo = {
			osName: client.osName,
			osVersion: client.osVersion,
			clientName: parseInt(
				Constants.CLIENT_NAME_IDS[
					client.clientName as keyof typeof Constants.CLIENT_NAME_IDS
				],
				10,
			),
			clientVersion: client.clientVersion,
		};
		const sabrFormats = streamingData.adaptive_formats.map(buildSabrFormat);

		/**
		 * googlevideo's SabrStream manages the SABR session. Its audio is fed
		 * straight into a MediaSource — the app is audio-only, so there's no
		 * manifest and no Shaka. YouTube currently caps a SABR session at
		 * roughly a minute; that limit is upstream and awaiting a library fix.
		 */
		const loadVideo = async () => {
			const stream = new SabrStream({
				videoId,
				fetchFunction: fetchFunction as unknown as typeof fetch,
				serverAbrStreamingUrl: await decipher(
					streamingData.server_abr_streaming_url,
				),
				videoPlaybackUstreamerConfig: ustreamerConfig ?? "",
				clientInfo,
				poToken: await botguardService.mintToken(videoId),
				formats: sabrFormats,
			});
			sabrStreamRef.current = stream;

			const { audioStream, selectedFormats } = stream.start({
				enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
				audioPreferences: {},
				isPostLiveDvr: false,
			});
			if (cancelled) {
				stream.abort();
				return;
			}

			const mime = selectedFormats.audioFormat?.mimeType;
			if (!mime) throw new Error("SABR audio format is missing.");

			mediaSource = new MediaSource();
			objectUrl = URL.createObjectURL(mediaSource);
			videoEl.src = objectUrl;
			await new Promise<void>((resolve) => {
				mediaSource?.addEventListener("sourceopen", () => resolve(), {
					once: true,
				});
			});
			if (cancelled || !mediaSource) return;

			const sourceBuffer = mediaSource.addSourceBuffer(mime);
			if (videoInfo.basic_info.duration) {
				mediaSource.duration = videoInfo.basic_info.duration;
			}

			reader =
				audioStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
			let started = false;
			while (!cancelled) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value || value.byteLength === 0) continue;
				await appendToSourceBuffer(sourceBuffer, value);
				if (!started) {
					started = true;
					videoEl.play().catch((error) => {
						// Ignore AbortError: play() interrupted by a pause.
						if ((error as Error).name !== "AbortError") {
							console.error("[PlayerContext] Auto-playback failed:", error);
						}
					});
				}
			}

			// Without an explicit endOfStream() the MediaSource never reports
			// the end of the track, so the element never fires `ended` and
			// playback just stalls at the last sample.
			if (!cancelled && mediaSource?.readyState === "open") {
				try {
					mediaSource.endOfStream();
				} catch (error) {
					console.warn("[PlayerContext] endOfStream failed:", error);
				}
			}
		};

		loadVideo().catch((error) => {
			if (!cancelled) {
				console.error("[PlayerContext] Load video error:", error);
			}
		});

		return () => {
			cancelled = true;
			reader?.cancel().catch(() => undefined);
			sabrStreamRef.current?.abort();
			sabrStreamRef.current = null;
			if (videoEl.src.startsWith("blob:")) {
				videoEl.removeAttribute("src");
				videoEl.load();
			}
			if (objectUrl) URL.revokeObjectURL(objectUrl);
			mediaSource = null;
		};
	}, [videoInfo, innertube]);

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
	// needs two clicks to resume.
	useEffect(() => {
		const videoEl = videoElementRef.current;
		if (!videoEl) return;
		const sync = () => setIsPlaying(!videoEl.paused);
		videoEl.addEventListener("play", sync);
		videoEl.addEventListener("pause", sync);
		return () => {
			videoEl.removeEventListener("play", sync);
			videoEl.removeEventListener("pause", sync);
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

	const playSong = useCallback(async (song: Song) => {
		setIsPlaying(false);
		setCurrentSong(song);
		setVideoInfo(null);
		setInnertube(null);

		try {
			if (!isVideoId(song.id)) {
				throw new Error(
					`Invalid video id "${song.id}" for "${song.title}" — cannot play`,
				);
			}
			const result = await getSongStream(song.id);
			if (result) {
				// Debug: dump everything YouTube returned for this song
				console.log(
					"[YuMusic] song info:",
					JSON.parse(JSON.stringify(result.videoInfo.basic_info ?? {})),
				);
				console.log(
					"[YuMusic] streaming data:",
					JSON.parse(JSON.stringify(result.videoInfo.streaming_data ?? {})),
				);
				setVideoInfo(result.videoInfo);
				setInnertube(result.innertube);
				setIsPlaying(true);

				// Upgrade the artwork from the player response. YT Music's square
				// cover (googleusercontent) is kept — it is the clean artwork,
				// and swapping in the 16:9 video frame re-frames it visibly when
				// the new image lands. Other sources take the biggest variant,
				// center-cut to a square for music (googleusercontent URLs get
				// a server-side crop, ytimg ones are cropped by the square
				// containers' object-fit).
				const basic = result.videoInfo.basic_info;
				const best = biggestThumb(basic.thumbnail);
				if (best) {
					setCurrentSong((prev) => {
						if (!prev || prev.id !== basic.id) return prev;
						const thumbnail = /googleusercontent\.com|ggpht\.com/.test(
							prev.thumbnail,
						)
							? hiResThumb(prev.thumbnail, 1024)
							: basic.category === "Music"
								? hiResThumb(best.url)
								: best.url;
						return { ...prev, thumbnail };
					});
				}
			}
		} catch (error) {
			console.error(
				"[PlayerContext] Failed to play song:",
				error,
				error instanceof Error ? error.stack : undefined,
			);
		}
	}, []);

	// Feed the shared listening-session tracker: one tick per second while
	// playing. It defines the grace period both the watch-history ping and
	// ListenBrainz use, and the scrobble threshold.
	useEffect(() => {
		if (!currentSong || !isPlaying) return;
		const videoEl = videoElementRef.current;
		listeningSession.start(currentSong.id, videoEl?.duration ?? 0);
		const timer = window.setInterval(() => {
			if (videoEl && Number.isFinite(videoEl.duration)) {
				listeningSession.setDuration(videoEl.duration);
			}
			listeningSession.tick(1);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [currentSong, isPlaying]);

	// Register the play in YouTube's watch history — the same ping the web
	// player sends — once the track has passed the shared grace period, so
	// instant skips are never tracked.
	useEffect(() => {
		if (!settings.watchHistory || !videoInfo) return;
		return listeningSession.subscribe((event, songId) => {
			if (event !== "established") return;
			if (songId !== videoInfo.basic_info.id) return;
			reportPlayback(videoInfo);
		});
	}, [settings.watchHistory, videoInfo]);

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
			if (currentSong?.id === song.id) {
				setIsPlaying(true);
				return;
			}

			// Add current song to history if it exists
			if (currentSong) {
				setHistory((prev) => [...prev, currentSong]);
			}

			// A fresh start gets a fresh radio: drop the old track's suggestions
			// so the effect below refetches for the new current song.
			setAutoplayTracks([]);
			autoplayForRef.current = null;

			// If a new queue is provided, add the current song to the front and set it
			if (newQueue) {
				setQueueState([song, ...newQueue]);
				setCurrentIndex(0);
			} else {
				// Find the song in the existing queue
				const index = queue.findIndex((s) => s.id === song.id);
				if (index !== -1) {
					setCurrentIndex(index);
				} else {
					// Song not in queue, add it to the front
					setQueueState([song, ...queue]);
					setCurrentIndex(0);
				}
			}

			await playSong(song);
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
			if (currentSong?.id === song.id) {
				setIsPlaying(true);
				return;
			}
			if (currentSong) {
				setHistory((prev) => [...prev, currentSong]);
			}
			// A fresh start gets a fresh radio (same as `play`).
			setAutoplayTracks([]);
			autoplayForRef.current = null;
			setQueueState(songs);
			setCurrentIndex(index);
			await playSong(song);
		},
		[currentSong, playSong],
	);

	const next = useCallback(async () => {
		if (currentIndex >= queue.length - 1) {
			// Queue finished: move into the autoplay section. Use the visible
			// suggestions when present, otherwise fetch a mix now.
			if (!currentSong) return;
			let upcoming = autoplayTracks;
			if (upcoming.length === 0) {
				if (!settings.autoplay || autoplayLoadingRef.current) return;
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
			setHistory((prev) => [...prev, currentSong]);
			const nextIndex = currentIndex + 1;
			setCurrentIndex(nextIndex);
			await playSong(upNext);
			return;
		}

		const nextIndex = currentIndex + 1;
		const nextSong = queue[nextIndex];

		// Add current song to history
		if (currentSong) {
			setHistory((prev) => [...prev, currentSong]);
		}

		setCurrentIndex(nextIndex);
		await playSong(nextSong);
	}, [
		currentIndex,
		queue,
		currentSong,
		settings.autoplay,
		playSong,
		autoplayTracks,
	]);

	const previous = useCallback(async () => {
		// Try to go back in queue first
		if (currentIndex > 0) {
			const prevIndex = currentIndex - 1;
			const prevSong = queue[prevIndex];

			// Add current song to history
			if (currentSong) {
				setHistory((prev) => [...prev, currentSong]);
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
	}, [currentIndex, queue, history, currentSong, playSong]);

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
				setHistory((prev) => [...prev, currentSong]);
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

	const setQueue = useCallback((songs: Song[]) => {
		setQueueState(songs);
	}, []);

	const pause = useCallback(() => setIsPlaying(false), []);
	const resume = useCallback(() => setIsPlaying(true), []);
	const toggle = useCallback(() => setIsPlaying((playing) => !playing), []);

	const hasNext =
		currentIndex < queue.length - 1 || (settings.autoplay && !!currentSong);
	const hasPrevious = currentIndex > 0 || history.length > 0;
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
						{/* Persistent hidden video element - must always be mounted so Shaka can attach to it */}
						<video
							className="pointer-events-none fixed top-0 left-0 h-px w-px opacity-0"
							onEnded={() => {
								void next();
							}}
							playsInline
							ref={videoElementRef}
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
