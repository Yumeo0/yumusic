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
import { botguardService } from "@/lib/botguard-service";
import { MAX_VOLUME } from "@/lib/hooks";
import { biggestThumb, hiResThumb, parseDuration } from "@/lib/utils";
import { isVideoId } from "@/lib/youtube.utils";
import { fetchFunction, getSongStream } from "@/lib/youtube-client";

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
	videoInfo: YT.VideoInfo | null;
	innertube: Innertube | null;
	queue: Song[];
	currentIndex: number;
	addToQueue: (songs: Song[]) => void;
	setQueue: (songs: Song[]) => void;
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

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [currentSong, setCurrentSong] = useState<Song | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [videoInfo, setVideoInfo] = useState<YT.VideoInfo | null>(null);
	const [innertube, setInnertube] = useState<Innertube | null>(null);
	const [queue, setQueueState] = useState<Song[]>([]);
	const [currentIndex, setCurrentIndex] = useState(-1);
	const [history, setHistory] = useState<Song[]>([]);
	const queueSheetRef = useRef<HTMLElement | null>(null);
	const [videoContainerRef] = useState<RefObject<HTMLDivElement> | null>(null);
	const videoElementRef = useRef<HTMLVideoElement>(null);
	const sabrStreamRef = useRef<SabrStream | null>(null);
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

				// Swap the list-item thumbnail for the best one the player
				// response carries: the biggest variant, center-cut to a square
				// for music (googleusercontent URLs get a server-side crop,
				// ytimg ones are cropped by the square containers' object-fit).
				// Uses the canonical size so the URL matches the list thumbnail
				// and reuses its HTTP cache entry instead of fetching a variant.
				const basic = result.videoInfo.basic_info;
				const best = biggestThumb(basic.thumbnail);
				if (best) {
					const thumbnail =
						basic.category === "Music" ? hiResThumb(best.url) : best.url;
					setCurrentSong((prev) =>
						prev && prev.id === basic.id ? { ...prev, thumbnail } : prev,
					);
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

	const next = useCallback(async () => {
		if (currentIndex >= queue.length - 1) return;

		const nextIndex = currentIndex + 1;
		const nextSong = queue[nextIndex];

		// Add current song to history
		if (currentSong) {
			setHistory((prev) => [...prev, currentSong]);
		}

		setCurrentIndex(nextIndex);
		await playSong(nextSong);
	}, [currentIndex, queue, currentSong, playSong]);

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

	const addToQueue = useCallback((songs: Song[]) => {
		setQueueState((prev) => [...prev, ...songs]);
	}, []);

	const setQueue = useCallback((songs: Song[]) => {
		setQueueState(songs);
	}, []);

	const pause = useCallback(() => setIsPlaying(false), []);
	const resume = useCallback(() => setIsPlaying(true), []);
	const toggle = useCallback(() => setIsPlaying((playing) => !playing), []);

	const hasNext = currentIndex < queue.length - 1;
	const hasPrevious = currentIndex > 0 || history.length > 0;
	const duration =
		parseDuration(currentSong?.duration) || videoInfo?.basic_info.duration || 0;

	const playerValue = useMemo<PlayerContextType>(
		() => ({
			currentSong,
			play,
			videoInfo,
			innertube,
			queue,
			currentIndex,
			addToQueue,
			setQueue,
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
			videoInfo,
			innertube,
			queue,
			currentIndex,
			addToQueue,
			setQueue,
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
								if (hasNext) next();
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
