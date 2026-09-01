import { SabrStreamingAdapter } from "googlevideo/sabr-streaming-adapter";
import { buildSabrFormat } from "googlevideo/utils";
import {
	createContext,
	type ReactNode,
	type RefObject,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import shaka from "shaka-player/dist/shaka-player.ui";
import { Constants, Utils } from "youtubei.js";
import { type Innertube, YT } from "youtubei.js/web";
import { botguardService } from "@/lib/botguard-service";
import { MAX_VOLUME } from "@/lib/hooks";
import { ShakaPlayerAdapter } from "@/lib/shaka-player-adapter";
import { biggestThumb, hiResThumb } from "@/lib/utils";
import { getSongStream } from "@/lib/youtube-client";

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

interface PlayerContextType {
	currentSong: Song | null;
	isPlaying: boolean;
	play: (song: Song, queue?: Song[]) => void;
	pause: () => void;
	resume: () => void;
	toggle: () => void;
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
	isNowPlayingOpen: boolean;
	toggleNowPlaying: () => void;
	isQueueOpen: boolean;
	toggleQueue: () => void;
	setQueueOpen: (open: boolean) => void;
	videoContainerRef: RefObject<HTMLDivElement | null> | null;
	videoElementRef: RefObject<HTMLVideoElement | null> | null;
	volume: number;
	setVolume: (volume: number) => void;
}

const PlayerContext = createContext<PlayerContextType | undefined>(undefined);

export function PlayerProvider({ children }: { children: ReactNode }) {
	const [currentSong, setCurrentSong] = useState<Song | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [videoInfo, setVideoInfo] = useState<YT.VideoInfo | null>(null);
	const [innertube, setInnertube] = useState<Innertube | null>(null);
	const [queue, setQueueState] = useState<Song[]>([]);
	const [currentIndex, setCurrentIndex] = useState(-1);
	const [history, setHistory] = useState<Song[]>([]);
	const [isNowPlayingOpen, setIsNowPlayingOpen] = useState(false);
	const [isQueueOpen, setIsQueueOpen] = useState(false);
	const [videoContainerRef] = useState<RefObject<HTMLDivElement> | null>(null);
	const videoElementRef = useRef<HTMLVideoElement>(null);
	const playerRef = useRef<shaka.Player | null>(null);
	const poTokenRef = useRef<string | null>(null);
	const [sabrAdapter, setSabrAdapter] = useState<SabrStreamingAdapter | null>(
		null,
	);
	const [playerReady, setPlayerReady] = useState(false);
	const [volume, _setVolume] = useState(() => {
		const savedVolume = localStorage.getItem("yumusic-volume");
		const parsed = savedVolume ? Number.parseFloat(savedVolume) : NaN;
		return Number.isFinite(parsed)
			? Math.min(MAX_VOLUME, Math.max(0, parsed))
			: MAX_VOLUME;
	});

	// Initialize Shaka Player
	useEffect(() => {
		shaka.polyfill.installAll();

		if (!shaka.Player.isBrowserSupported()) {
			console.error(
				"[PlayerContext] Shaka Player is not supported on this browser.",
			);
			return;
		}

		const videoEl = videoElementRef.current;
		if (!videoEl) {
			return;
		}

		const player = new shaka.Player();
		player.configure({
			abr: { enabled: true },
			streaming: {
				bufferingGoal: 120,
				rebufferingGoal: 2,
			},
		});

		player
			.attach(videoEl)
			.then(() => {
				playerRef.current = player;
				setPlayerReady(true);
			})
			.catch((error) => {
				console.error("[PlayerContext] Failed to attach player:", error);
			});

		return () => {
			if (playerRef.current) {
				const currentPlayer = playerRef.current;
				playerRef.current = null;
				setPlayerReady(false);

				currentPlayer.destroy().catch((error) => {
					console.warn("[PlayerContext] Error during cleanup:", error);
				});
			}
		};
	}, []);

	// Load video when videoInfo changes and player is ready
	// biome-ignore lint/correctness/useExhaustiveDependencies: the SABR adapter is intentionally recreated per video inside the effect.
	useEffect(() => {
		const loadVideo = async () => {
			if (!playerReady || !playerRef.current) {
				return;
			}

			if (!videoInfo || !innertube) {
				return;
			}

			const cpn = Utils.generateRandomString(16);
			const videoId = videoInfo.basic_info.id;

			// Dispose old SABR adapter and create a new one for the new video
			if (sabrAdapter) {
				try {
					sabrAdapter.dispose();
				} catch (error) {
					console.warn("[PlayerContext] Error disposing SABR adapter:", error);
				}
			}
			await playerRef.current.unload();

			// Create a new SABR adapter instance for this video
			const newSabrAdapter = new SabrStreamingAdapter({
				playerAdapter: new ShakaPlayerAdapter(),
				clientInfo: {
					osName: innertube.session.context.client.osName,
					osVersion: innertube.session.context.client.osVersion,
					clientName: parseInt(
						Constants.CLIENT_NAME_IDS[
							innertube.session.context.client
								.clientName as keyof typeof Constants.CLIENT_NAME_IDS
						],
						10,
					),
					clientVersion: innertube.session.context.client.clientVersion,
				},
			});
			setSabrAdapter(newSabrAdapter);

			const isLive = videoInfo.basic_info.is_live;
			const isPostLiveDVR =
				!!videoInfo.basic_info.is_post_live_dvr ||
				(videoInfo.basic_info.is_live_content &&
					!!(
						videoInfo.streaming_data?.dash_manifest_url ||
						videoInfo.streaming_data?.hls_manifest_url
					));

			newSabrAdapter.onMintPoToken(async () => {
				const visitorData = innertube.session.context.client.visitorData;
				if (!visitorData) {
					throw new Error("Missing visitor data");
				}
				return botguardService.mintToken(visitorData);
			});

			newSabrAdapter.onReloadPlayerResponse(async (reloadContext: unknown) => {
				const visitorData = innertube.session.context.client.visitorData;
				if (!visitorData) {
					throw new Error("Missing visitor data");
				}
				const poToken = await botguardService.mintToken(visitorData);
				poTokenRef.current = poToken;

				const reloadedInfo = await innertube.actions.execute("/player", {
					videoId,
					contentCheckOk: true,
					racyCheckOk: true,
					playbackContext: {
						adPlaybackContext: {
							pyv: true,
						},
						contentPlaybackContext: {
							signatureTimestamp: innertube.session.player?.signature_timestamp,
						},
						reloadPlaybackContext: reloadContext,
					},
					serviceIntegrityDimensions: {
						poToken,
					},
				});

				const parsedInfo = new YT.VideoInfo(
					[reloadedInfo],
					innertube.actions,
					cpn,
				);
				newSabrAdapter.setStreamingURL(
					await innertube.session.player?.decipher(
						parsedInfo.streaming_data?.server_abr_streaming_url,
					),
				);
				newSabrAdapter.setUstreamerConfig(
					videoInfo.player_config?.media_common_config
						.media_ustreamer_request_config?.video_playback_ustreamer_config,
				);
			});

			newSabrAdapter.attach(playerRef.current);

			if (videoInfo.streaming_data && !isPostLiveDVR && !isLive) {
				newSabrAdapter.setStreamingURL(
					await innertube.session.player?.decipher(
						videoInfo.streaming_data?.server_abr_streaming_url,
					),
				);
				newSabrAdapter.setUstreamerConfig(
					videoInfo.player_config?.media_common_config
						.media_ustreamer_request_config?.video_playback_ustreamer_config,
				);
				newSabrAdapter.setServerAbrFormats(
					videoInfo.streaming_data.adaptive_formats.map(buildSabrFormat),
				);
			}

			let manifestUri: string | undefined;
			if (videoInfo.streaming_data) {
				if (isLive) {
					manifestUri = videoInfo.streaming_data.dash_manifest_url
						? `${videoInfo.streaming_data.dash_manifest_url}/mpd_version/7`
						: videoInfo.streaming_data.hls_manifest_url;
				} else if (isPostLiveDVR) {
					manifestUri =
						videoInfo.streaming_data.hls_manifest_url ||
						`${videoInfo.streaming_data.dash_manifest_url}/mpd_version/7`;
				} else {
					const mpd = await videoInfo.toDash({
						manifest_options: {
							is_sabr: true,
							captions_format: "vtt",
							include_thumbnails: false,
						},
					});
					manifestUri = `data:application/dash+xml;base64,${btoa(mpd)}`;
				}
			}

			if (!manifestUri) throw new Error("Could not find a valid manifest URI.");

			try {
				await playerRef.current.load(manifestUri);

				// Start playback automatically after loading
				if (videoElementRef.current) {
					videoElementRef.current
						.play()
						.catch((e) => console.error("Auto-playback failed", e));
				}
			} catch (error) {
				// shaka.util.Error instances carry severity/category/code/data;
				// log them as plain values, since DevTools shows the minified
				// constructor name for the raw object.
				console.error(
					"[PlayerContext] Failed to load manifest:",
					JSON.stringify(
						{
							message: (error as Error)?.message,
							severity: (error as { severity?: unknown }).severity,
							category: (error as { category?: unknown }).category,
							code: (error as { code?: unknown }).code,
							data: (error as { data?: unknown }).data,
							stack: (error as Error)?.stack?.split("\n").slice(0, 6),
						},
						(_, v) => (typeof v === "bigint" ? v.toString() : v),
						2,
					),
				);
				throw error;
			}
		};

		loadVideo().catch((error) => {
			console.error("[PlayerContext] Load video error:", error);
		});
	}, [videoInfo, innertube, playerReady]);

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

	const setVolume = (next: number) => {
		_setVolume(Math.min(MAX_VOLUME, Math.max(0, next)));
	};

	const playSong = async (song: Song) => {
		setIsPlaying(false);
		setCurrentSong(song);
		setVideoInfo(null);
		setInnertube(null);
		poTokenRef.current = null;

		try {
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
				poTokenRef.current = result.poToken;
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
	};

	const play = async (song: Song, newQueue?: Song[]) => {
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
	};

	const next = async () => {
		if (currentIndex >= queue.length - 1) return;

		const nextIndex = currentIndex + 1;
		const nextSong = queue[nextIndex];

		// Add current song to history
		if (currentSong) {
			setHistory((prev) => [...prev, currentSong]);
		}

		setCurrentIndex(nextIndex);
		await playSong(nextSong);
	};

	const previous = async () => {
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
	};

	const addToQueue = (songs: Song[]) => {
		setQueueState((prev) => [...prev, ...songs]);
	};

	const setQueue = (songs: Song[]) => {
		setQueueState(songs);
	};

	const pause = () => setIsPlaying(false);
	const resume = () => setIsPlaying(true);
	const toggle = () => setIsPlaying(!isPlaying);
	const toggleNowPlaying = () => setIsNowPlayingOpen(!isNowPlayingOpen);
	const toggleQueue = () => setIsQueueOpen(!isQueueOpen);
	const setQueueOpen = (open: boolean) => setIsQueueOpen(open);
	const hasNext = currentIndex < queue.length - 1;
	const hasPrevious = currentIndex > 0 || history.length > 0;

	return (
		<PlayerContext.Provider
			value={{
				currentSong,
				isPlaying,
				play,
				pause,
				resume,
				toggle,
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
				isNowPlayingOpen,
				toggleNowPlaying,
				isQueueOpen,
				toggleQueue,
				setQueueOpen,
				videoContainerRef,
				videoElementRef,
				volume,
				setVolume,
			}}
		>
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
