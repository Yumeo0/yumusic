import { useEffect, useRef } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { BufferingWatchdog } from "@/lib/listen-together/buffering-watchdog";
import {
	actionContextError,
	queueKey,
} from "@/lib/listen-together/guest-permissions";
import { listenRoom } from "@/lib/listen-together/room";
import {
	expectedPosition,
	playbackInstance,
	SHARED_AUTOPLAY_LIMIT,
	sharedPlaybackQueue,
	wireSong,
} from "@/lib/player/shared-playback";
import { showToast } from "@/lib/stores/toast";
import { formatTime } from "@/lib/utils/utils";

function hostTrack(player: ReturnType<typeof usePlayer>) {
	const { currentSong, playingVideoId, currentIndex, queue, duration } = player;
	const queued = queue[currentIndex];
	const song = currentSong
		? {
				...currentSong,
				id: playingVideoId || currentSong.id,
				duration:
					currentSong.duration ||
					(duration > 0 ? formatTime(duration) : undefined),
				addedBy:
					queued?.id === currentSong.id ? queued.addedBy : currentSong.addedBy,
			}
		: null;
	return {
		song,
		instance: playbackInstance(
			player.getPlaybackGeneration(),
			currentIndex,
			song?.id,
		),
	};
}

/** Reads media clocks outside React; frequent room ticks never rerender the app. */
export function RoomPlaybackBridge() {
	const player = usePlayer();
	const controls = usePlayerControls();
	const live = useRef({ player, controls });
	live.current = { player, controls };
	useEffect(() => {
		const releaseActions = listenRoom.setActionHandler(
			async (action, context) => {
				const { player: p, controls: c } = live.current;
				const track = hostTrack(p);
				const shared = sharedPlaybackQueue(
					p.queue,
					p.currentIndex,
					p.currentSong,
					track.song,
				);
				const error = actionContextError(action, context, {
					instance: track.instance,
					queueKey: queueKey(shared.queue),
				});
				if (error) throw new Error(error);
				const start = shared.sourceStart;
				switch (action.type) {
					case "autoplay":
						if (
							!p.autoplayEnabled ||
							queueKey(p.autoplayTracks.slice(0, SHARED_AUTOPLAY_LIMIT)) !==
								action.queueKey ||
							!p.autoplayTracks[action.index]
						)
							throw new Error("The autoplay queue changed. Please try again.");
						p.playAutoplayAt(action.index, action.addedBy);
						break;
					case "play":
						await p.play(action.song);
						break;
					case "playQueue":
						await p.playQueue(action.songs, action.index);
						break;
					case "add":
						await p.addToQueue(action.songs, action.songs[0]?.addedBy);
						break;
					case "playNext":
						await p.playNext(action.song, action.song.addedBy);
						break;
					case "next":
						await p.next();
						break;
					case "previous":
						await p.previous();
						break;
					case "pause":
						c.pause();
						break;
					case "resume":
						c.resume();
						break;
					case "toggle":
						c.toggle();
						break;
					case "seek":
						p.seek(action.position);
						break;
					case "repeat":
						p.setRepeatMode(action.mode);
						break;
					case "remove":
						if (start === null || !shared.queue[action.index])
							throw new Error("That queue item no longer exists.");
						p.removeFromQueueAt(start + action.index);
						break;
					case "shuffle":
						p.shuffleQueue();
						break;
					case "reorder": {
						if (start === null || action.order.length !== shared.queue.length)
							throw new Error("The queue changed. Please try again.");
						const end = start + shared.queue.length;
						p.setQueue([
							...p.queue.slice(0, start),
							...action.order.map((i) => p.queue[start + i]),
							...p.queue.slice(end),
						]);
						break;
					}
				}
			},
		);
		let noticeId = "";
		const releaseNotice = listenRoom.subscribe(() => {
			const notice = listenRoom.getSnapshot().notice;
			if (notice && notice.id !== noticeId) {
				noticeId = notice.id;
				showToast(notice.message);
			}
		});
		let requested = "";
		let prepared = "";
		let aligned = "";
		let failed = "";
		const buffering = new BufferingWatchdog();
		let previousRole: string | null = null;
		let lastSent = 0;
		let previousKey = "";
		let previousPosition = 0;
		let previousTime = performance.now();
		let playPending = false;
		let appliedQueue: unknown = null;
		let appliedAutoplay: unknown = null;
		let audioMode = "listen";
		const tick = () => {
			const { player: p, controls: c } = live.current;
			const room = listenRoom.getSnapshot();
			const media = p.videoElementRef?.current;
			const now = performance.now();
			if (previousRole === "guest" && room.role !== "guest") {
				requested = prepared = aligned = failed = "";
				appliedQueue = null;
				appliedAutoplay = null;
				buffering.clear();
			}
			previousRole = room.role;
			if (!room.role) return;
			if (room.role === "host") {
				const playing =
					!!media &&
					c.isPlaying &&
					!media.paused &&
					!media.ended &&
					media.readyState >= 3;
				const position =
					media && Number.isFinite(media.currentTime) ? media.currentTime : 0;
				const { instance, song: actualSong } = hostTrack(p);
				const key = `${instance}:${playing}:${p.queue.length}:${p.repeatMode}`;
				const jumped =
					Math.abs(
						position -
							previousPosition -
							(playing ? (now - previousTime) / 1000 : 0),
					) > 0.4;
				if (key !== previousKey || jumped || now - lastSent >= 1000) {
					const { queue, index, song } = sharedPlaybackQueue(
						p.queue,
						p.currentIndex,
						p.currentSong,
						actualSong,
					);
					listenRoom.broadcastPlayback({
						instance,
						queue,
						index,
						song,
						autoplayQueue: p.autoplayEnabled
							? p.autoplayTracks
									.slice(0, SHARED_AUTOPLAY_LIMIT)
									.map((song) => wireSong(song))
							: [],
						autoplayEnabled: p.autoplayEnabled,
						position,
						playing,
						repeatMode: p.repeatMode,
					});
					lastSent = now;
					previousKey = key;
				}
				previousPosition = position;
				previousTime = now;
				listenRoom.setStatus(
					playing ? "listening" : c.isPlaying ? "buffering" : "paused",
				);
				return;
			}
			const state = room.playback;
			if (audioMode !== room.guestAudio) {
				audioMode = room.guestAudio;
				requested = prepared = aligned = failed = "";
				buffering.clear();
			}
			if (room.guestAudio === "remote") {
				const key = `remote:${state?.instance ?? "empty"}`;
				if (requested !== key) {
					requested = key;
					p.previewRoomTrack(
						state?.song ?? null,
						state?.queue ?? [],
						state?.index ?? -1,
					);
				}
				media?.pause();
				p.setRoomPlaying(false);
				listenRoom.setStatus("paused");
				if (state && appliedQueue !== state.queue) {
					p.applyRoomQueue(state.queue, state.index);
					appliedQueue = state.queue;
				}
				if (state && appliedAutoplay !== state.autoplayQueue) {
					p.applyRoomAutoplay(state.autoplayQueue);
					appliedAutoplay = state.autoplayQueue;
				}
				return;
			}
			if (state && appliedAutoplay !== state.autoplayQueue) {
				p.applyRoomAutoplay(state.autoplayQueue);
				appliedAutoplay = state.autoplayQueue;
			}
			if (state && appliedQueue !== state.queue) {
				p.applyRoomQueue(state.queue, state.index);
				appliedQueue = state.queue;
			}
			if (
				room.status !== "connected" ||
				room.clockOffset === null ||
				!state?.song
			) {
				buffering.clear();
				media?.pause();
				p.setRoomPlaying(false);
				listenRoom.setStatus(
					room.status === "connected" && !state?.song ? "paused" : "buffering",
				);
				return;
			}
			if (requested !== state.instance) {
				buffering.begin(now);
				requested = state.instance;
				prepared = aligned = "";
				const instance = state.instance;
				void p
					.prepareRoomTrack(state.song, state.queue, state.index)
					.then(() => {
						if (
							requested === instance &&
							listenRoom.getSnapshot().role === "guest" &&
							listenRoom.getSnapshot().guestAudio === "listen"
						)
							prepared = instance;
					})
					.catch((error: unknown) => {
						if (error instanceof Error && error.name === "AbortError") return;
						if (
							requested !== instance ||
							listenRoom.getSnapshot().role !== "guest"
						)
							return;
						failed = instance;
						showToast(
							"This track could not play on your device. You will rejoin on the next track.",
						);
					});
			}
			if (failed === state.instance) {
				listenRoom.setStatus("unavailable");
				return;
			}
			const ready =
				prepared === state.instance &&
				!!media &&
				media.readyState >= 2 &&
				!media.seeking &&
				p.currentSong?.id === state.song.id;
			if (
				(prepared === state.instance && media?.error) ||
				buffering.expired(now, ready)
			) {
				failed = state.instance;
				listenRoom.setStatus("unavailable");
				showToast(
					"This track is unavailable on your device. You will rejoin on the next track.",
				);
				return;
			}
			if (
				prepared !== state.instance ||
				failed === state.instance ||
				!media ||
				media.readyState < 2 ||
				p.currentSong?.id !== state.song.id ||
				media.seeking
			) {
				listenRoom.setStatus("buffering");
				return;
			}
			const target = Math.min(
				expectedPosition(state, now + room.clockOffset),
				Number.isFinite(media.duration)
					? Math.max(0, media.duration - 0.05)
					: Infinity,
			);
			const drift = target - media.currentTime;
			if (aligned !== state.instance || Math.abs(drift) > 0.8) {
				// Seeking outside the buffered window restarts SABR. Give that
				// operation its own recovery window, even minutes into a song.
				buffering.begin(now);
				media.currentTime = target;
				aligned = state.instance;
				media.playbackRate = 1;
			} else
				media.playbackRate =
					state.playing && Math.abs(drift) > 0.15
						? drift > 0
							? 1.02
							: 0.98
						: 1;
			if (state.playing && media.paused && !playPending) {
				playPending = true;
				void media
					.play()
					.then(() => {
						const current = listenRoom.getSnapshot();
						if (
							current.role === "guest" &&
							current.guestAudio === "listen" &&
							current.playback?.instance === state.instance
						)
							p.setRoomPlaying(true);
						else if (current.role === "guest") media.pause();
					})
					.catch((error: unknown) => {
						if (error instanceof Error && error.name === "AbortError") return;
						if (
							listenRoom.getSnapshot().role !== "guest" ||
							requested !== state.instance
						)
							return;
						if (failed !== state.instance)
							showToast(
								"Playback was blocked. Leave and rejoin the room to try again.",
							);
						failed = state.instance;
					})
					.finally(() => {
						playPending = false;
					});
			} else if (!state.playing) {
				media.pause();
				p.setRoomPlaying(false);
			}
			listenRoom.setStatus(
				state.playing && !media.paused ? "listening" : "paused",
			);
		};
		const timer = window.setInterval(tick, 150);
		tick();
		return () => {
			releaseActions();
			releaseNotice();
			window.clearInterval(timer);
			const media = live.current.player.videoElementRef?.current;
			if (media) media.playbackRate = 1;
			listenRoom.leave();
		};
	}, []);
	return null;
}
