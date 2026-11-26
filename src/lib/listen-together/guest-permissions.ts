import type { Song } from "@/lib/music/song";
import type { RepeatMode } from "@/lib/player/repeat";
import { notifySyncChange } from "../sync/events";

export type PermissionMode = "allow" | "suggest" | "deny";
export const permissionLabels = {
	select: "Choose songs",
	add: "Add to queue / play next",
	skip: "Skip / previous song",
	remove: "Remove songs",
	reorder: "Reorder / shuffle queue",
	playback: "Play / pause",
	seek: "Seek within a song",
	repeat: "Change repeat mode",
} as const;
export type PermissionCategory = keyof typeof permissionLabels;
export type GuestPermissions = Record<PermissionCategory, PermissionMode>;
export const defaultPermissions: GuestPermissions = {
	select: "allow",
	add: "allow",
	skip: "allow",
	remove: "allow",
	reorder: "allow",
	playback: "allow",
	seek: "allow",
	repeat: "allow",
};
const validMode = (value: unknown): value is PermissionMode =>
	typeof value === "string" && ["allow", "suggest", "deny"].includes(value);
export function validPermissions(value: unknown): value is GuestPermissions {
	return (
		!!value &&
		typeof value === "object" &&
		Object.keys(defaultPermissions).every((key) =>
			validMode((value as GuestPermissions)[key as PermissionCategory]),
		)
	);
}

export type RoomAction =
	| { type: "play"; song: Song }
	| { type: "playQueue"; songs: Song[]; index: number }
	| { type: "add"; songs: Song[] }
	| { type: "playNext"; song: Song }
	| { type: "autoplay"; index: number; queueKey: string; addedBy?: string }
	| { type: "next" | "previous" | "pause" | "resume" | "toggle" | "shuffle" }
	| { type: "remove"; index: number }
	| { type: "reorder"; order: number[] }
	| { type: "seek"; position: number }
	| { type: "repeat"; mode: RepeatMode };

export interface ActionContext {
	instance: string | null;
	queueKey: string;
}
export interface RoomRequest {
	id: string;
	song: Song | null;
	action: RoomAction;
	context: ActionContext;
	profile: { username: string; avatar: string | null };
	from: string;
}

export function actionCategory(action: RoomAction): PermissionCategory {
	switch (action.type) {
		case "play":
		case "playQueue":
		case "autoplay":
			return "select";
		case "add":
		case "playNext":
			return "add";
		case "next":
		case "previous":
			return "skip";
		case "remove":
			return "remove";
		case "reorder":
		case "shuffle":
			return "reorder";
		case "pause":
		case "resume":
		case "toggle":
			return "playback";
		case "seek":
			return "seek";
		case "repeat":
			return "repeat";
	}
}
export const queueKey = (songs: Song[]) =>
	JSON.stringify(songs.map((song) => song.id));

const requiredContext: Partial<Record<PermissionCategory, "track" | "queue">> =
	{
		skip: "track",
		playback: "track",
		seek: "track",
		remove: "queue",
		reorder: "queue",
	};

export function actionContextError(
	action: RoomAction,
	expected: ActionContext,
	current: ActionContext,
) {
	const required = requiredContext[actionCategory(action)];
	if (required && expected.instance !== current.instance)
		return "The track changed. Please try again.";
	if (required === "queue" && expected.queueKey !== current.queueKey)
		return "The queue changed. Please try again.";
	return null;
}

export function actionSong(action: RoomAction): Song | null {
	if (action.type === "play" || action.type === "playNext") return action.song;
	if (action.type === "playQueue") return action.songs[action.index] ?? null;
	if (action.type === "add") return action.songs[0] ?? null;
	return null;
}
export function actionLabel(action: RoomAction, subject?: Song | null): string {
	switch (action.type) {
		case "play":
			return `Play ${action.song.title}`;
		case "playQueue":
			return `Play ${action.songs[action.index]?.title} and its queue`;
		case "autoplay":
			return subject
				? `Play ${subject.title}`
				: "Play an autoplay recommendation";
		case "add":
			return action.songs.length === 1
				? `Queue ${action.songs[0].title}`
				: `Queue ${action.songs.length} songs`;
		case "playNext":
			return `Play next: ${action.song.title}`;
		case "next":
			return "Skip to the next song";
		case "previous":
			return "Play the previous song";
		case "remove":
			return subject
				? `Remove ${subject.title}`
				: `Remove queue item ${action.index + 1}`;
		case "reorder":
			return "Reorder the queue";
		case "shuffle":
			return "Shuffle upcoming songs";
		case "seek":
			return `Seek to ${Math.floor(action.position / 60)}:${String(Math.floor(action.position % 60)).padStart(2, "0")}`;
		case "repeat":
			return `Set repeat: ${action.mode}`;
		case "pause":
			return "Pause playback";
		case "resume":
			return "Resume playback";
		case "toggle":
			return "Toggle play / pause";
	}
}

const STORAGE_KEY = "yumusic:guest-permissions:v1";

export function readSavedGuestPermissions():
	| GuestPermissions
	| undefined
	| null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return undefined;
		const value: unknown = JSON.parse(raw);
		if (!validPermissions(value)) return null;
		return Object.fromEntries(
			Object.keys(defaultPermissions).map((key) => [
				key,
				value[key as PermissionCategory],
			]),
		) as GuestPermissions;
	} catch {
		return null;
	}
}

export function replaceSavedGuestPermissions(value: GuestPermissions | null) {
	if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	else localStorage.removeItem(STORAGE_KEY);
	notifySyncChange();
}

export interface PermissionsStorage {
	read: () => GuestPermissions;
	write: (value: GuestPermissions) => void;
}
export const permissionsStorage: PermissionsStorage = {
	read() {
		const saved = readSavedGuestPermissions();
		if (saved === undefined) return { ...defaultPermissions };
		return (
			saved ??
			(Object.fromEntries(
				Object.keys(defaultPermissions).map((key) => [key, "deny"]),
			) as GuestPermissions)
		);
	},
	write(value) {
		try {
			replaceSavedGuestPermissions(value);
		} catch {
			throw new Error("Could not save guest permissions.");
		}
	},
};
