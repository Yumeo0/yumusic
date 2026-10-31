import { describe, expect, test } from "bun:test";
import {
	expectedPosition,
	parseInvite,
	parseMessage,
	parseRoomAction,
	type RoomPlayback,
	wireSong,
} from "./protocol";

const song = {
	id: "abcdefghijk",
	title: "Song",
	artist: "Artist",
	thumbnail: "",
};
const playback: RoomPlayback = {
	revision: 1,
	instance: "track-1",
	queue: [song, song],
	autoplayQueue: [],
	autoplayEnabled: false,
	index: 1,
	song,
	position: 12,
	playing: true,
	sentAt: 1000,
	repeatMode: "off",
};
const parse = (p: unknown) =>
	parseMessage(
		JSON.stringify({ type: "state", session: "session", playback: p }),
	);

describe("room protocol", () => {
	test("shares bounded autoplay and per-entry attribution but strips forged guest attribution", () => {
		const shared = {
			...playback,
			queue: [
				{ ...song, addedBy: "Host" },
				{ ...song, addedBy: "Guest" },
			],
			autoplayQueue: [song],
			autoplayEnabled: true,
		};
		const message = parse(shared);
		expect(
			message?.type === "state" &&
				message.playback.queue.map((entry) => entry.addedBy),
		).toEqual(["Host", "Guest"]);
		expect(message?.type === "state" && message.playback.autoplayQueue).toEqual(
			[song],
		);
		expect(
			parse({ ...shared, autoplayQueue: Array(101).fill(song) }),
		).toBeNull();
		expect(
			parseRoomAction({ type: "add", songs: [{ ...song, addedBy: "Forged" }] }),
		).toEqual({ type: "add", songs: [song] });
		expect(
			parseRoomAction({ type: "autoplay", index: -1, queueKey: "[]" }),
		).toBeNull();
	});
	test("guest commands are bounded and reorder commands must be permutations", () => {
		expect(parseRoomAction({ type: "play", song })?.type).toBe("play");
		expect(parseRoomAction({ type: "add", songs: [] })).toBeNull();
		expect(
			parseRoomAction({ type: "add", songs: Array(301).fill(song) }),
		).toBeNull();
		expect(parseRoomAction({ type: "reorder", order: [1, 0, 2] })).toEqual({
			type: "reorder",
			order: [1, 0, 2],
		});
		expect(parseRoomAction({ type: "reorder", order: [0, 0] })).toBeNull();
		expect(parseRoomAction({ type: "reorder", order: [0, 2] })).toBeNull();
		expect(parseRoomAction({ type: "seek", position: -1 })).toBeNull();
		expect(parseRoomAction({ type: "remove", index: 1.5 })).toBeNull();
		expect(
			parseRoomAction({ type: "playQueue", songs: [song], index: 2 }),
		).toBeNull();
	});
	test("allows duplicate tracks and validates the selected queue slot", () => {
		expect(parse(playback)?.type).toBe("state");
		expect(parse({ ...playback, index: 4 })).toBeNull();
		expect(
			parse({ ...playback, song: { ...song, id: "differentid" } }),
		).toBeNull();
	});
	test("rejects malformed messages, invalid positions, huge queues and URL injection", () => {
		expect(parseMessage("broken json")).toBeNull();
		expect(parseMessage({ type: "hello" })).toBeNull();
		expect(parse({ ...playback, position: -1 })).toBeNull();
		expect(parse({ ...playback, queue: Array(301).fill(song) })).toBeNull();
		expect(
			parse({
				...playback,
				song: { ...song, thumbnail: "javascript:alert(1)" },
			}),
		).toBeNull();
		expect(parse({ ...playback, revision: 0.5 })).toBeNull();
	});
	test("projects the host timeline only while playing", () => {
		expect(expectedPosition(playback, 3500)).toBe(14.5);
		expect(expectedPosition({ ...playback, playing: false }, 3500)).toBe(12);
		expect(expectedPosition(playback, 500)).toBe(12);
	});
	test("strips local metadata and requires a complete invitation token", () => {
		expect(
			wireSong({ ...song, description: "private metadata" }),
		).not.toHaveProperty("description");
		expect(parseInvite(`yu1.host.${"a".repeat(32)}`)?.host).toBe("host");
		expect(parseInvite("yu1.host.short")).toBeNull();
		expect(parseInvite("https://example.com")).toBeNull();
	});
});
