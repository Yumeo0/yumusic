import {
	type PlaybackSnapshot,
	parsePlaybackSnapshot,
	playbackThumbnail,
} from "../player/shared-playback";

export type DeviceCommand = "pause" | "resume" | "next" | "previous";
export type DeviceRequest =
	| { type: "control"; command: DeviceCommand }
	| { type: "transfer"; playback: PlaybackSnapshot }
	| { type: "handoff"; target: string };

export function parseDeviceRequest(input: unknown): DeviceRequest | null {
	if (!input || typeof input !== "object") return null;
	const m = input as Record<string, unknown>;
	const command = m.command;
	if (
		m.type === "control" &&
		(command === "pause" ||
			command === "resume" ||
			command === "next" ||
			command === "previous")
	)
		return { type: "control", command };
	if (
		m.type === "handoff" &&
		typeof m.target === "string" &&
		/^[a-f0-9-]{36}$/.test(m.target)
	)
		return { type: "handoff", target: m.target };
	if (m.type === "transfer") {
		const playback = parsePlaybackSnapshot(m.playback);
		if (playback?.song) return { type: "transfer", playback };
	}
	return null;
}

export interface DeviceStatus {
	thumbnail?: string;
	upload?: boolean;
	playing: boolean;
	title: string;
	artist: string;
	room: boolean;
}
export function deviceStatus(input: unknown): DeviceStatus {
	const s = (input && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
	return {
		thumbnail: playbackThumbnail(s.thumbnail),
		upload: s.upload === true,
		playing: s.playing === true,
		room: s.room === true,
		title: typeof s.title === "string" ? s.title.slice(0, 500) : "",
		artist: typeof s.artist === "string" ? s.artist.slice(0, 500) : "",
	};
}
