import {
	parseMessage,
	type RoomPlayback,
	wireSong,
} from "../listen-together/protocol";

export type DeviceCommand = "pause" | "resume" | "next" | "previous";
export type DeviceRequest =
	| { type: "control"; command: DeviceCommand }
	| { type: "transfer"; playback: RoomPlayback }
	| { type: "handoff"; target: string };

export function parseDeviceRequest(input: unknown): DeviceRequest | null {
	if (!input || typeof input !== "object") return null;
	const m = input as Record<string, unknown>;
	if (
		m.type === "control" &&
		["pause", "resume", "next", "previous"].includes(String(m.command))
	)
		return { type: "control", command: m.command as DeviceCommand };
	if (
		m.type === "handoff" &&
		typeof m.target === "string" &&
		/^[a-f0-9-]{36}$/.test(m.target)
	)
		return { type: "handoff", target: m.target };
	if (m.type === "transfer") {
		let state: ReturnType<typeof parseMessage>;
		try {
			state = parseMessage(
				JSON.stringify({
					type: "state",
					session: "connect",
					playback: m.playback,
				}),
			);
		} catch {
			return null;
		}
		if (state?.type === "state" && state.playback.song)
			return { type: "transfer", playback: state.playback };
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
		thumbnail: wireSong({
			id: "",
			title: "",
			artist: "",
			thumbnail: typeof s.thumbnail === "string" ? s.thumbnail : "",
		}).thumbnail,
		upload: s.upload === true,
		playing: s.playing === true,
		room: s.room === true,
		title: typeof s.title === "string" ? s.title.slice(0, 500) : "",
		artist: typeof s.artist === "string" ? s.artist.slice(0, 500) : "",
	};
}
