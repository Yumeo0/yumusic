import type { Song } from "@/lib/music/song";
import { isRepeatMode, type RepeatMode } from "./repeat";

export interface PlaybackSnapshot {
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

export const SHARED_QUEUE_LIMIT = 300;
export const SHARED_AUTOPLAY_LIMIT = 100;
const SHARED_QUEUE_HISTORY = 100;

export function sharedQueueWindow<T>(queue: T[], index: number) {
	const start = Math.max(0, index - SHARED_QUEUE_HISTORY);
	return {
		queue: queue.slice(start, start + SHARED_QUEUE_LIMIT),
		index: index - start,
	};
}

export function sharedPlaybackQueue(
	queue: Song[],
	index: number,
	current: Song | null,
	playingSong?: Song | null,
) {
	if (current && queue[index]?.id !== current.id) {
		queue = [current, ...queue];
		index = 0;
	}
	const visible = sharedQueueWindow(queue, index);
	const currentTrack = playingSong === undefined ? current : playingSong;
	return {
		sourceIndex: index,
		index: current ? visible.index : -1,
		queue: visible.queue.map((song, i) =>
			wireSong(i === visible.index && playingSong ? playingSong : song),
		),
		song: currentTrack ? wireSong(currentTrack) : null,
	};
}

export function playbackInstance(
	generation: number,
	index: number,
	id?: string,
) {
	return `${generation}:${index}:${id || "empty"}`;
}

const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) =>
	typeof value === "string" && value.length <= max;
const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

function parseSongs(value: unknown, limit: number): Song[] | null {
	if (!Array.isArray(value) || value.length > limit) return null;
	const songs: Song[] = [];
	for (const song of value) {
		if (!validSong(song)) return null;
		songs.push(wireSong(song));
	}
	return songs;
}

export function parsePlaybackSnapshot(value: unknown): PlaybackSnapshot | null {
	if (!record(value)) return null;
	const {
		revision,
		instance,
		index,
		song,
		position,
		playing,
		sentAt,
		repeatMode,
		autoplayEnabled,
	} = value;
	const queue = parseSongs(value.queue, SHARED_QUEUE_LIMIT);
	const autoplayQueue = parseSongs(value.autoplayQueue, SHARED_AUTOPLAY_LIMIT);
	if (
		!queue ||
		!autoplayQueue ||
		!Number.isSafeInteger(revision) ||
		Number(revision) < 0 ||
		typeof instance !== "string" ||
		instance.length > 200 ||
		!Number.isInteger(index) ||
		Number(index) < -1 ||
		Number(index) >= queue.length ||
		!(song === null || validSong(song)) ||
		!finite(position) ||
		position < 0 ||
		position > 86_400 ||
		!finite(sentAt) ||
		typeof playing !== "boolean" ||
		typeof autoplayEnabled !== "boolean" ||
		!isRepeatMode(repeatMode)
	)
		return null;
	if (song && queue[Number(index)]?.id !== song.id) return null;
	return {
		revision: Number(revision),
		instance,
		queue,
		autoplayQueue,
		autoplayEnabled,
		index: Number(index),
		song: song ? wireSong(song) : null,
		position,
		playing,
		sentAt,
		repeatMode,
	};
}

export function validParticipantName(username: unknown): username is string {
	return (
		typeof username === "string" &&
		username.trim() === username &&
		username.length > 0 &&
		username.length <= 40 &&
		!Array.from(username).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		)
	);
}

export function validSong(v: unknown): v is Song {
	return (
		record(v) &&
		typeof v.id === "string" &&
		/^[A-Za-z0-9_-]{11}$/.test(v.id) &&
		text(v.title, 500) &&
		text(v.artist, 500) &&
		text(v.thumbnail, 2000) &&
		(v.thumbnail === "" || /^https:\/\//.test(String(v.thumbnail))) &&
		(v.duration === undefined || text(v.duration, 30)) &&
		(v.addedBy === undefined || validParticipantName(v.addedBy))
	);
}

export function playbackThumbnail(url: unknown): string {
	try {
		if (typeof url !== "string") return "";
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

/** Deliberately omit descriptions, playback URLs and any account/session data. */
export function wireSong(song: Song, attribution = true): Song {
	return {
		id: song.id,
		title: song.title.slice(0, 500),
		artist: song.artist.slice(0, 500),
		thumbnail: playbackThumbnail(song.thumbnail),
		duration: song.duration,
		...(attribution && song.addedBy ? { addedBy: song.addedBy } : {}),
	};
}

export function expectedPosition(p: PlaybackSnapshot, hostNow: number): number {
	return Math.max(
		0,
		p.position + (p.playing ? Math.max(0, hostNow - p.sentAt) / 1000 : 0),
	);
}
