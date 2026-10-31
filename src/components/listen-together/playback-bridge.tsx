import { useEffect, useRef } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { BufferingWatchdog } from "@/lib/listen-together/buffering-watchdog";
import {
	actionCategory,
	queueKey,
} from "@/lib/listen-together/guest-permissions";
import { expectedPosition, wireSong } from "@/lib/listen-together/protocol";
import { listenRoom } from "@/lib/listen-together/room";
import { showToast } from "@/lib/stores/toast";

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
				const category = actionCategory(action);
				const shared = listenRoom.getSnapshot().playback;
				const currentInstance = `${p.getPlaybackGeneration()}:${p.currentIndex}:${p.videoInfo?.basic_info.id || p.currentSong?.id || "empty"}`;
				if (
					["skip", "remove", "reorder", "seek", "playback"].includes(
						category,
					) &&
					context.instance !== currentInstance
				)
					throw new Error("The track changed. Please try again.");
				const offset = shared ? Math.max(0, p.currentIndex - shared.index) : 0;
				const window = p.queue.slice(
					offset,
					offset + (shared?.queue.length ?? 0),
				);
				if (
					["remove", "reorder"].includes(category) &&
					queueKey(window) !== context.queueKey
				)
					throw new Error("The queue changed. Please try again.");
				switch (action.type) {
					case "autoplay":
						if (queueKey(p.autoplayTracks.slice(0, 100)) !== action.queueKey || !p.autoplayTracks[action.index])
							throw new Error("The autoplay queue changed. Please try again.");
						p.playAutoplayAt(action.index);
						break;
					case "play":
						await p.play(action.song);
						break;
					case "playQueue":
						await p.playQueue(action.songs, action.index);
						break;
					case "add":
						await p.addToQueue(action.songs);
						break;
					case "playNext":
						p.playNext(action.song);
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
						if (!window[action.index])
							throw new Error("That queue item no longer exists.");
						p.removeFromQueueAt(offset + action.index);
						break;
					case "shuffle":
						p.shuffleQueue();
						break;
					case "reorder": {
						if (action.order.length !== window.length)
							throw new Error("The queue changed. Please try again.");
						p.setQueue([
							...p.queue.slice(0, offset),
							...action.order.map((i) => window[i]),
							...p.queue.slice(offset + window.length),
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
				const actualSong = p.currentSong
					? {
							...p.currentSong,
							id: p.videoInfo?.basic_info.id || p.currentSong.id,
						}
					: null;
				const instance = `${p.getPlaybackGeneration()}:${p.currentIndex}:${actualSong?.id || "empty"}`;
				const key = `${instance}:${playing}:${p.queue.length}:${p.repeatMode}`;
				const jumped =
					Math.abs(
						position -
							previousPosition -
							(playing ? (now - previousTime) / 1000 : 0),
					) > 0.4;
				if (key !== previousKey || jumped || now - lastSent >= 1000) {
					let queue = p.queue;
					let index = p.currentIndex;
					// History navigation can play a song outside the visible queue.
					if (p.currentSong && queue[index]?.id !== p.currentSong.id) {
						queue = [p.currentSong, ...queue];
						index = 0;
					}
					if (actualSong)
						queue = queue.map((song, i) => (i === index ? actualSong : song));
					const start = Math.max(0, index - 100);
					listenRoom.broadcastPlayback({
						instance,
						queue: queue.slice(start, start + 300).map((song) => wireSong(song)),
						autoplayQueue: p.autoplayEnabled ? p.autoplayTracks.slice(0, 100).map((song) => wireSong(song)) : [],
						autoplayEnabled: p.autoplayEnabled,
						index: p.currentSong ? index - start : -1,
						song: actualSong ? wireSong(actualSong) : null,
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
							listenRoom.getSnapshot().role === "guest"
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
