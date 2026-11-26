import { useEffect, useRef } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { DeviceHub } from "@/lib/connect/hub";
import { AccountDeviceDiscovery, deviceId } from "@/lib/connect/lifecycle";
import { deviceStatus } from "@/lib/connect/protocol";
import { deviceRepository } from "@/lib/connect/repository";
import { attachDeviceHub, getDeviceHub } from "@/lib/connect/store";
import { peerOptions } from "@/lib/listen-together/peer-options";
import { listenRoom } from "@/lib/listen-together/room";
import {
	type PlaybackSnapshot,
	playbackInstance,
	SHARED_AUTOPLAY_LIMIT,
	sharedPlaybackQueue,
	wireSong,
} from "@/lib/player/shared-playback";
import { updateSettings } from "@/lib/stores/settings";
import { watchSyncAccount } from "@/lib/sync/client";
import { matchesYouTubeAccount } from "@/lib/sync/youtube-account";

/** No audio bytes, cookies or credentials cross devices; each plays its own stream. */
export function DeviceBridge() {
	const player = usePlayer();
	const controls = usePlayerControls();
	const live = useRef({ player, controls });
	live.current = { player, controls };
	useEffect(() => {
		let stopped = false;
		const discovery = new AccountDeviceDiscovery({
			eligible: (session) => matchesYouTubeAccount(session.user),
			attach: attachDeviceHub,
			create: (session) => {
				const id = deviceId(session.user.id);
				let preparedGeneration = -1;
				const available = () =>
					!stopped &&
					matchesYouTubeAccount(session.user) &&
					!listenRoom.getSnapshot().role;
				return new DeviceHub(
					id,
					deviceRepository(session.user.id, id),
					{
						available,
						status: () =>
							deviceStatus({
								thumbnail: live.current.player.currentSong?.thumbnail,
								upload: live.current.player.currentSong?.upload,
								playing: live.current.controls.isPlaying,
								title: live.current.player.currentSong?.title,
								artist: live.current.player.currentSong?.artist,
								room: !!listenRoom.getSnapshot().role,
							}),
						playback: () => {
							const { player: p, controls: c } = live.current;
							if (!p.currentSong) return null;
							const { sourceIndex, queue, index, song } = sharedPlaybackQueue(
								p.queue,
								p.currentIndex,
								p.currentSong,
							);
							return {
								revision: 0,
								instance: playbackInstance(
									p.getPlaybackGeneration(),
									sourceIndex,
									p.currentSong.id,
								),
								queue,
								index,
								song,
								autoplayQueue: p.autoplayTracks
									.slice(0, SHARED_AUTOPLAY_LIMIT)
									.map((s) => wireSong(s)),
								autoplayEnabled: p.autoplayEnabled,
								repeatMode: p.repeatMode,
								position: Math.max(
									0,
									p.videoElementRef?.current?.currentTime ?? 0,
								),
								playing: c.isPlaying,
								sentAt: Date.now(),
							};
						},
						prepare: async (state, valid) => {
							if (!available() || !valid() || !state.song)
								throw new Error(
									"Leave Listen together before transferring playback.",
								);
							const preparation = live.current.player.prepareRoomTrack(
								state.song,
								state.queue,
								state.index,
							);
							preparedGeneration = live.current.player.getPlaybackGeneration();
							await preparation;
							if (
								!valid() ||
								preparedGeneration !==
									live.current.player.getPlaybackGeneration()
							)
								throw new Error("The destination track changed. Try again.");
						},
						start: async (state: PlaybackSnapshot, valid) => {
							const p = live.current.player;
							const media = p.videoElementRef?.current;
							if (
								!valid() ||
								!media ||
								preparedGeneration !== p.getPlaybackGeneration()
							)
								throw new Error("Transfer cancelled.");
							// Position advances while the source keeps playing during preparation.
							const elapsed = state.playing
								? Math.max(0, Math.min(25, (Date.now() - state.sentAt) / 1000))
								: 0;
							media.currentTime = Math.min(
								state.position + elapsed,
								Number.isFinite(media.duration)
									? Math.max(0, media.duration - 0.1)
									: Infinity,
							);
							p.setRepeatMode(state.repeatMode);
							updateSettings({ autoplay: state.autoplayEnabled });
							p.applyRoomAutoplay(state.autoplayQueue);
							if (state.playing) await media.play();
							if (
								!valid() ||
								preparedGeneration !== p.getPlaybackGeneration()
							) {
								if (preparedGeneration === p.getPlaybackGeneration())
									media.pause();
								throw new Error("Transfer cancelled.");
							}
							p.setRoomPlaying(state.playing);
						},
						pause: () => {
							live.current.player.videoElementRef?.current?.pause();
							live.current.player.setRoomPlaying(false);
						},
						cancelTransfer: () => {
							if (
								preparedGeneration !==
								live.current.player.getPlaybackGeneration()
							)
								return;
							live.current.player.videoElementRef?.current?.pause();
							live.current.player.setRoomPlaying(false);
						},
						control: (command) => {
							if (!available())
								throw new Error(
									"Use the room controls while listening together.",
								);
							const { player: p, controls: c } = live.current;
							if (command === "pause") c.pause();
							else if (command === "resume") c.resume();
							else if (command === "next") p.next();
							else p.previous();
						},
					},
					async () => {
						const { Peer } = await import("peerjs");
						return new Peer(await peerOptions());
					},
				);
			},
		});
		const stopAccountWatch = watchSyncAccount((session) =>
			discovery.setSession(session),
		);
		const refresh = () => {
			if (document.visibilityState === "visible")
				void getDeviceHub()?.refresh();
		};
		window.addEventListener("online", refresh);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			stopped = true;
			stopAccountWatch();
			discovery.stop();
			window.removeEventListener("online", refresh);
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: publish when playback changes, reading the latest state through live.
	useEffect(() => {
		const timer = setTimeout(() => {
			void getDeviceHub()?.refresh();
		}, 500);
		return () => clearTimeout(timer);
	}, [controls.isPlaying, player.currentSong?.id]);
	return null;
}
