import type { Song } from "@/contexts/player-context";
import type { RepeatMode } from "@/lib/player/repeat";
import {
	type ActionContext,
	type GuestPermissions,
	type RoomAction,
	validPermissions,
} from "./guest-permissions";
import {
	type JoinChallenge,
	validNonce,
	validPublicKey,
	validSignature,
} from "./identity";
import { type RoomProfile, validProfile } from "./profile";

export interface Participant {
	id: string;
	profile: RoomProfile;
	status: "listening" | "buffering" | "paused" | "unavailable";
	fingerprint?: string;
}
export interface RoomPlayback {
	revision: number;
	instance: string;
	queue: Song[];
	autoplayQueue: Song[];
	autoplayEnabled: boolean;
	index: number;
	song: Song | null;
	position: number;
	playing: boolean;
	sentAt: number;
	repeatMode: RepeatMode;
}
export type RoomMessage =
	| { type: "identity-request"; challenge: JoinChallenge }
	| {
			type: "identity-proof";
			challenge: JoinChallenge;
			publicKey: string;
			profile: RoomProfile;
			signature: string;
	  }
	| {
			type: "hello";
			version: 2;
			token: string;
			profile: RoomProfile;
			publicKey: string;
	  }
	| ({ type: "challenge" } & JoinChallenge)
	| { type: "proof"; nonce: string; signature: string }
	| {
			type: "welcome";
			session: string;
			members: Participant[];
			permissions: GuestPermissions;
	  }
	| { type: "permissions"; permissions: GuestPermissions }
	| { type: "action"; id: string; action: RoomAction; context: ActionContext }
	| { type: "action-result"; id: string; message: string }
	| { type: "members"; members: Participant[] }
	| { type: "profile"; profile: RoomProfile }
	| { type: "suggest"; song: Song }
	| { type: "status"; status: Participant["status"] }
	| { type: "state"; session: string; playback: RoomPlayback }
	| {
			type: "tick";
			session: string;
			revision: number;
			instance: string;
			position: number;
			playing: boolean;
			sentAt: number;
	  }
	| { type: "ping"; id: number; at: number }
	| { type: "pong"; id: number; at: number; hostAt: number }
	| { type: "end"; reason: string };

const record = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 200) =>
	typeof v === "string" && v.length <= max;
const finite = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);
export const validStatus = (v: unknown) =>
	["listening", "buffering", "paused", "unavailable"].includes(String(v));
function validSong(v: unknown): v is Song {
	return (
		record(v) &&
		typeof v.id === "string" &&
		/^[A-Za-z0-9_-]{11}$/.test(v.id) &&
		text(v.title, 500) &&
		text(v.artist, 500) &&
		text(v.thumbnail, 2000) &&
		(v.thumbnail === "" || /^https:\/\//.test(String(v.thumbnail))) &&
		(v.duration === undefined || text(v.duration, 30)) &&
		(v.addedBy === undefined ||
			validProfile({ username: v.addedBy, avatar: null }))
	);
}
function validMembers(v: unknown): v is Participant[] {
	return (
		Array.isArray(v) &&
		v.length <= 8 &&
		v.every(
			(m) =>
				record(m) &&
				text(m.id) &&
				validProfile(m.profile) &&
				validStatus(m.status) &&
				(m.fingerprint === undefined ||
					(typeof m.fingerprint === "string" &&
						/^[a-f0-9]{64}$/.test(m.fingerprint))),
		)
	);
}

export function parseRoomAction(value: unknown): RoomAction | null {
	if (!record(value)) return null;
	const songs = value.songs;
	switch (value.type) {
		case "autoplay":
			return Number.isInteger(value.index) && Number(value.index) >= 0 && Number(value.index) < 100 && text(value.queueKey, 2000)
				? { type: "autoplay", index: Number(value.index), queueKey: String(value.queueKey) }
				: null;
		case "play":
		case "playNext":
			return validSong(value.song)
				? { type: value.type, song: wireSong(value.song, false) }
				: null;
		case "add":
		case "playQueue": {
			if (
				!Array.isArray(songs) ||
				!songs.length ||
				songs.length > 300 ||
				!songs.every(validSong)
			)
				return null;
			if (value.type === "add")
				return { type: "add", songs: songs.map((song) => wireSong(song, false)) };
			return Number.isInteger(value.index) &&
				Number(value.index) >= 0 &&
				Number(value.index) < songs.length
				? {
						type: "playQueue",
						songs: songs.map((song) => wireSong(song, false)),
						index: Number(value.index),
					}
				: null;
		}
		case "next":
		case "previous":
		case "pause":
		case "resume":
		case "toggle":
		case "shuffle":
			return { type: value.type };
		case "remove":
			return Number.isInteger(value.index) &&
				Number(value.index) >= 0 &&
				Number(value.index) < 300
				? { type: "remove", index: Number(value.index) }
				: null;
		case "reorder": {
			const order = value.order;
			return Array.isArray(order) &&
				order.length <= 300 &&
				new Set(order).size === order.length &&
				order.every((i) => Number.isInteger(i) && i >= 0 && i < order.length)
				? { type: "reorder", order }
				: null;
		}
		case "seek":
			return finite(value.position) &&
				value.position >= 0 &&
				value.position <= 86400
				? { type: "seek", position: value.position }
				: null;
		case "repeat":
			return ["off", "one", "all"].includes(String(value.mode)) &&
				typeof value.mode === "string"
				? { type: "repeat", mode: value.mode as RepeatMode }
				: null;
		default:
			return null;
	}
}

/** Only small, bounded, versioned JSON messages cross the room boundary. */
export function parseMessage(raw: unknown): RoomMessage | null {
	if (typeof raw !== "string" || raw.length > 1_200_000) return null;
	try {
		const m: unknown = JSON.parse(raw);
		if (!record(m)) return null;
		switch (m.type) {
			case "identity-request":
			case "identity-proof": {
				const c = m.challenge;
				if (
					!record(c) ||
					!validNonce(c.nonce) ||
					!text(c.session) ||
					!text(c.host) ||
					!text(c.guest)
				)
					return null;
				if (
					m.type === "identity-proof" &&
					(!validPublicKey(m.publicKey) ||
						!validSignature(m.signature) ||
						!validProfile(m.profile))
				)
					return null;
				return m as RoomMessage;
			}
			case "hello":
				return m.version === 2 &&
					text(m.token, 100) &&
					validProfile(m.profile) &&
					validPublicKey(m.publicKey)
					? (m as RoomMessage)
					: null;
			case "challenge":
				return validNonce(m.nonce) &&
					text(m.session) &&
					text(m.host) &&
					text(m.guest)
					? (m as RoomMessage)
					: null;
			case "proof":
				return validNonce(m.nonce) && validSignature(m.signature)
					? (m as RoomMessage)
					: null;
			case "welcome":
				return text(m.session) &&
					validMembers(m.members) &&
					validPermissions(m.permissions)
					? (m as RoomMessage)
					: null;
			case "permissions":
				return validPermissions(m.permissions) ? (m as RoomMessage) : null;
			case "action-result":
				return text(m.id, 100) && text(m.message, 300)
					? (m as RoomMessage)
					: null;
			case "action": {
				const action = parseRoomAction(m.action);
				const c = m.context;
				return action &&
					text(m.id, 100) &&
					record(c) &&
					(c.instance === null || text(c.instance)) &&
					text(c.queueKey, 10000)
					? {
							type: "action",
							id: String(m.id),
							action,
							context: {
								instance: c.instance as string | null,
								queueKey: String(c.queueKey),
							},
						}
					: null;
			}
			case "members":
				return validMembers(m.members) ? (m as RoomMessage) : null;
			case "profile":
				return validProfile(m.profile) ? (m as RoomMessage) : null;
			case "status":
				return validStatus(m.status) ? (m as RoomMessage) : null;
			case "ping":
				return finite(m.id) && finite(m.at) ? (m as RoomMessage) : null;
			case "pong":
				return finite(m.id) && finite(m.at) && finite(m.hostAt)
					? (m as RoomMessage)
					: null;
			case "suggest":
				return validSong(m.song)
					? { type: "suggest", song: wireSong(m.song) }
					: null;
			case "end":
				return text(m.reason) ? (m as RoomMessage) : null;
			case "tick":
				return text(m.session) &&
					text(m.instance) &&
					Number.isSafeInteger(m.revision) &&
					Number(m.revision) >= 0 &&
					finite(m.position) &&
					m.position >= 0 &&
					m.position <= 86400 &&
					typeof m.playing === "boolean" &&
					finite(m.sentAt)
					? (m as RoomMessage)
					: null;
			case "state": {
				const p = m.playback;
				if (
					!text(m.session) ||
					!record(p) ||
					!Number.isSafeInteger(p.revision) ||
					Number(p.revision) < 0 ||
					!text(p.instance) ||
					!Array.isArray(p.queue) ||
					p.queue.length > 300 ||
					!p.queue.every(validSong) ||
					!Array.isArray(p.autoplayQueue) ||
					p.autoplayQueue.length > 100 ||
					!p.autoplayQueue.every(validSong) ||
					typeof p.autoplayEnabled !== "boolean" ||
					!Number.isInteger(p.index) ||
					Number(p.index) < -1 ||
					Number(p.index) >= p.queue.length ||
					!(p.song === null || validSong(p.song)) ||
					!finite(p.position) ||
					p.position < 0 ||
					p.position > 86400 ||
					!finite(p.sentAt) ||
					typeof p.playing !== "boolean" ||
					!["off", "one", "all"].includes(String(p.repeatMode))
				)
					return null;
				if (
					p.song &&
					(p.index === -1 || p.queue[Number(p.index)].id !== p.song.id)
				)
					return null;
				// Strip unrecognized fields before data reaches the player and UI.
				return {
					type: "state",
					session: String(m.session),
					playback: {
						revision: Number(p.revision),
						instance: String(p.instance),
						queue: p.queue.map((song) => wireSong(song)),
						autoplayQueue: p.autoplayQueue.map((song) => wireSong(song)),
						autoplayEnabled: p.autoplayEnabled,
						index: Number(p.index),
						song: p.song ? wireSong(p.song as unknown as Song) : null,
						position: p.position,
						playing: p.playing,
						sentAt: p.sentAt,
						repeatMode: p.repeatMode as RepeatMode,
					},
				};
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
}

/** Deliberately omit descriptions, playback URLs and any account/session data. */
function safeThumbnail(url: string): string {
	try {
		const parsed = new URL(url);
		const allowed = ["ytimg.com", "googleusercontent.com", "ggpht.com"].some(
			(host) =>
				parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
		);
		return parsed.protocol === "https:" && allowed ? url.slice(0, 2000) : "";
	} catch {
		return "";
	}
}

export function wireSong(song: Song, attribution = true): Song {
	return {
		id: song.id,
		title: song.title.slice(0, 500),
		artist: song.artist.slice(0, 500),
		thumbnail: safeThumbnail(song.thumbnail),
		duration: song.duration,
		...(attribution && song.addedBy ? { addedBy: song.addedBy } : {}),
	};
}

export function expectedPosition(p: RoomPlayback, hostNow: number): number {
	return Math.max(
		0,
		p.position + (p.playing ? Math.max(0, hostNow - p.sentAt) / 1000 : 0),
	);
}

export function parseInvite(
	input: string,
): { host: string; token: string } | null {
	const match = /^yu1\.([A-Za-z0-9_-]{1,100})\.([a-f0-9]{32})$/.exec(
		input.trim(),
	);
	return match ? { host: match[1], token: match[2] } : null;
}
