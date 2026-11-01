import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { usePlayer, usePlayerControls } from "@/contexts/player-context";
import { DeviceHub } from "@/lib/connect/hub";
import { AccountDeviceDiscovery, deviceId } from "@/lib/connect/lifecycle";
import { attachDeviceHub, getDeviceHub } from "@/lib/connect/store";
import { peerOptions } from "@/lib/listen-together/peer-options";
import { type RoomPlayback, wireSong } from "@/lib/listen-together/protocol";
import { listenRoom } from "@/lib/listen-together/room";
import { updateSettings } from "@/lib/stores/settings";
import { accountDataClient, supabase } from "@/lib/sync/client";
import {
	matchesYouTubeAccount,
	YOUTUBE_ACCOUNT_CHANGED,
} from "@/lib/sync/youtube-account";
import { IS_ANDROID } from "@/lib/utils/tauri";

export const DEVICE_NAME_KEY = "yumusic:device-name:v1";
export function defaultDeviceName() {
	return IS_ANDROID
		? "Android phone"
		: isTauri()
			? /Windows/.test(navigator.userAgent)
				? "Windows PC"
				: "Desktop"
			: "Web browser";
}

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
				const client = accountDataClient(session.user.id);
				const id = deviceId(session.user.id);
				let preparedGeneration = -1;
				const available = () =>
					!stopped &&
					matchesYouTubeAccount(session.user) &&
					!listenRoom.getSnapshot().role;
				return new DeviceHub(
					id,
					{
						publish: async (peer, token, state) => {
							const { data, error } = await client.rpc(
								"publish_playback_device",
								{
									device_id: id,
									device_peer: peer,
									device_token: token,
									device_name: (
										localStorage.getItem(DEVICE_NAME_KEY)?.trim() ||
										defaultDeviceName()
									).slice(0, 80),
									device_kind: IS_ANDROID
										? "phone"
										: isTauri()
											? "desktop"
											: "browser",
									device_state: { ...state },
								},
							);
							if (error) throw error;
							return data;
						},
						remove: async (token) => {
							await client
								.from("playback_devices")
								.delete()
								.eq("user_id", session.user.id)
								.eq("id", id)
								.eq("connection_token", token);
						},
					},
					{
						available,
						status: () => ({
							thumbnail: live.current.player.currentSong
								? wireSong(live.current.player.currentSong).thumbnail
								: "",
							upload: live.current.player.currentSong?.upload ?? false,
							playing: live.current.controls.isPlaying,
							title: live.current.player.currentSong?.title.slice(0, 500) ?? "",
							artist:
								live.current.player.currentSong?.artist.slice(0, 500) ?? "",
							room: !!listenRoom.getSnapshot().role,
						}),
						playback: () => {
							const { player: p, controls: c } = live.current;
							if (!p.currentSong) return null;
							let queue = p.queue;
							let index = p.currentIndex;
							if (queue[index]?.id !== p.currentSong.id) {
								queue = [p.currentSong, ...queue];
								index = 0;
							}
							const start = Math.max(0, index - 100);
							return {
								revision: 0,
								instance: `${p.getPlaybackGeneration()}:${index}:${p.currentSong.id}`,
								queue: queue.slice(start, start + 300).map((s) => wireSong(s)),
								index: index - start,
								song: wireSong(p.currentSong),
								autoplayQueue: p.autoplayTracks
									.slice(0, 100)
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
							const until = performance.now() + 20_000;
							while (valid() && performance.now() < until) {
								if (
									preparedGeneration !==
									live.current.player.getPlaybackGeneration()
								)
									throw new Error("The destination track changed. Try again.");
								const media = live.current.player.videoElementRef?.current;
								if (media?.error)
									throw new Error(
										"This track is unavailable on the destination.",
									);
								if (media && media.readyState >= 2) return;
								await new Promise((resolve) => setTimeout(resolve, 100));
							}
							throw new Error("The destination could not load this track.");
						},
						start: async (state: RoomPlayback, valid) => {
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
		let authRevision = 0;
		const {
			data: { subscription },
		} = supabase.auth.onAuthStateChange((_event, session) => {
			authRevision++;
			// Do not call another Supabase API while inside the Auth callback.
			queueMicrotask(() => discovery.setSession(session));
		});
		const revision = authRevision;
		void supabase.auth
			.getSession()
			.then(({ data: { session } }) => {
				if (revision === authRevision) discovery.setSession(session);
			})
			.catch(() => undefined);
		window.addEventListener(YOUTUBE_ACCOUNT_CHANGED, discovery.reconcile);
		const refresh = () => {
			if (document.visibilityState === "visible")
				void getDeviceHub()?.refresh();
		};
		window.addEventListener("online", refresh);
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			stopped = true;
			subscription.unsubscribe();
			discovery.stop();
			window.removeEventListener(YOUTUBE_ACCOUNT_CHANGED, discovery.reconcile);
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
