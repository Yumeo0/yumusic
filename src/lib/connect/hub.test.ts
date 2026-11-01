import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Peer } from "peerjs";
import { type RoomPlayback, wireSong } from "../listen-together/protocol";
import { type DeviceAdapter, DeviceHub, type PlaybackDevice } from "./hub";
import { parseDeviceRequest } from "./protocol";

// Use the installed PeerJS codec: BinaryPack turns undefined fields into null.
const requirePeer = createRequire(import.meta.resolve("peerjs"));
const { pack, unpack } = requirePeer("peerjs-js-binarypack") as {
	pack(value: unknown): ArrayBuffer | Promise<ArrayBuffer>;
	unpack(value: ArrayBuffer): unknown;
};

class Channel extends EventEmitter {
	open = false;
	remote!: Channel;
	send(value: unknown) {
		const packed = pack(value);
		void Promise.resolve(packed).then((data) => {
			if (this.remote.open) this.remote.emit("data", unpack(data));
		});
	}
	close() {
		if (!this.open) return;
		this.open = this.remote.open = false;
		this.emit("close");
		this.remote.emit("close");
	}
}
class FakePeer extends EventEmitter {
	open = true;
	disconnected = false;
	destroyed = false;
	channels: Channel[] = [];
	constructor(
		readonly id: string,
		private network: Map<string, FakePeer>,
	) {
		super();
		network.set(id, this);
	}
	connect(id: string, _options?: unknown) {
		const target = this.network.get(id);
		if (!target) throw new Error("Device offline");
		const a = new Channel();
		const b = new Channel();
		a.remote = b;
		b.remote = a;
		this.channels.push(a);
		target.channels.push(b);
		queueMicrotask(() => {
			target.emit("connection", b);
			a.open = b.open = true;
			a.emit("open");
			b.emit("open");
		});
		return a;
	}
	destroy() {
		this.destroyed = true;
		for (const c of this.channels) c.close();
	}
	reconnect() {
		this.disconnected = false;
	}
}
const song = {
	id: "abcdefghijk",
	title: "Track",
	artist: "Artist",
	thumbnail: "",
};
const playback: RoomPlayback = {
	revision: 0,
	instance: "one",
	queue: [song],
	song,
	index: 0,
	autoplayQueue: [],
	autoplayEnabled: false,
	position: 37,
	playing: true,
	sentAt: 0,
	repeatMode: "all",
};
const hubs: DeviceHub[] = [];
afterEach(() => {
	for (const h of hubs) h.stop();
	hubs.length = 0;
});
function setup() {
	const network = new Map<string, FakePeer>();
	const rows = new Map<string, PlaybackDevice>();
	const make = async (owner = "owner", id = crypto.randomUUID()) => {
		let track = structuredClone(playback);
		let playing = true;
		let available = true;
		let prepares = 0;
		const peer = new FakePeer(id, network);
		const adapter: DeviceAdapter = {
			status: () => ({
				playing,
				title: song.title,
				artist: song.artist,
				room: !available,
			}),
			playback: () => ({ ...track, playing }),
			available: () => available,
			prepare: async (next) => {
				prepares++;
				track = next;
				playing = false;
			},
			start: async (next) => {
				playing = next.playing;
			},
			pause: () => {
				playing = false;
			},
			cancelTransfer: () => {
				playing = false;
			},
			control: (command) => {
				if (command === "resume") playing = true;
				if (command === "pause") playing = false;
			},
		};
		const hub = new DeviceHub(
			id,
			{
				publish: async (peer_id, connection_token, state) => {
					rows.set(id, {
						user_id: owner,
						id,
						peer_id,
						connection_token,
						state: { ...state },
						name: id,
						kind: "desktop",
						last_seen: new Date().toISOString(),
					});
					return [...rows.values()].filter((r) => r.user_id === owner);
				},
				remove: async (token) => {
					if (rows.get(id)?.connection_token === token) rows.delete(id);
				},
			},
			adapter,
			async () => peer as unknown as Peer,
		);
		hubs.push(hub);
		await hub.start();
		return {
			id,
			hub,
			adapter,
			peer,
			playing: () => playing,
			prepares: () => prepares,
			track: () => track,
			room: (value: boolean) => {
				available = !value;
			},
			changeTrack: () => {
				track = { ...track, instance: "new" };
			},
		};
	};
	return { make, rows };
}

test("handoff preserves the queue, repeat and position, then pauses the source", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	await a.hub.refresh();
	await a.hub.transfer(b.id);
	expect(a.playing()).toBe(false);
	expect(b.playing()).toBe(true);
	expect(b.track().position).toBe(37);
	expect(b.track().queue).toEqual([song]);
	expect(b.track().repeatMode).toBe("all");
	await a.hub.control(b.id, "pause");
	expect(b.playing()).toBe(false);
	await a.hub.control(b.id, "resume");
	expect(b.playing()).toBe(true);
});

test("startup publishes automatically even when the peer opened before handlers were attached", async () => {
	const s = setup();
	const pc = await s.make();
	expect(pc.hub.getSnapshot().status).toBe("online");
	expect(s.rows.has(pc.id)).toBe(true);
	expect(pc.hub.getSnapshot().devices.map((d) => d.id)).toEqual([pc.id]);
});

test("restarting a device replaces its entry and late old-session cleanup cannot delete it", async () => {
	const s = setup();
	const old = await s.make();
	const oldToken = s.rows.get(old.id)?.connection_token;
	const restarted = await s.make("owner", old.id);
	expect(s.rows.size).toBe(1);
	expect(s.rows.get(old.id)?.connection_token).not.toBe(oldToken);
	old.hub.stop();
	expect(s.rows.size).toBe(1);
	await restarted.hub.refresh();
	expect(restarted.hub.getSnapshot().devices.map((d) => d.id)).toEqual([
		old.id,
	]);
});
test("a phone can pull music from another device and hand it to a third device", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	const c = await s.make();
	await a.hub.refresh();
	await b.hub.refresh();
	await c.hub.refresh();
	await c.hub.move(a.id, b.id);
	expect(a.playing()).toBe(false);
	expect(b.playing()).toBe(true);
	await c.hub.move(b.id, c.id);
	expect(b.playing()).toBe(false);
	expect(c.playing()).toBe(true);
});
test("failed preparation and room destinations leave the source playing", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	await a.hub.refresh();
	b.adapter.prepare = async () => {
		throw new Error("Track unavailable");
	};
	await expect(a.hub.transfer(b.id)).rejects.toThrow("Track unavailable");
	expect(a.playing()).toBe(true);
	expect(b.playing()).toBe(false);
	b.room(true);
	await expect(a.hub.transfer(b.id)).rejects.toThrow();
	expect(a.playing()).toBe(true);
});
test("a changed source track cancels the handoff and stops the unconfirmed destination", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	await a.hub.refresh();
	b.adapter.prepare = async () => {
		a.changeTrack();
	};
	await expect(a.hub.transfer(b.id)).rejects.toThrow("source track changed");
	expect(a.playing()).toBe(true);
	expect(b.playing()).toBe(false);
});
test("account shutdown cancels an in-flight destination load", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	await a.hub.refresh();
	let release!: () => void;
	let loading!: () => void;
	const started = new Promise<void>((r) => {
		loading = r;
	});
	b.adapter.prepare = async () => {
		loading();
		await new Promise<void>((r) => {
			release = r;
		});
	};
	const result = a.hub.transfer(b.id).catch((e) => e);
	await started;
	b.hub.stop();
	release();
	expect(await result).toBeInstanceOf(Error);
	expect(a.playing()).toBe(true);
	expect(b.playing()).toBe(false);
});
test("another account cannot discover or control a device using a forged capability", async () => {
	const s = setup();
	const a = await s.make();
	const other = await s.make("other");
	await a.hub.refresh();
	expect(a.hub.getSnapshot().devices.some((d) => d.id === other.id)).toBe(
		false,
	);
	await expect(other.hub.control(a.id, "pause")).rejects.toThrow(
		"no longer available",
	);
	const conn = other.peer.connect(a.id);
	await new Promise<void>((resolve) => {
		conn.on("open", () => {
			conn.send({
				version: 1,
				token: crypto.randomUUID(),
				request: { type: "control", command: "pause" },
			});
		});
		conn.on("close", resolve);
	});
	expect(a.playing()).toBe(true);
	expect(a.prepares()).toBe(0);
});
test("malformed transfer payloads are rejected and unknown fields stripped", () => {
	expect(
		parseDeviceRequest({
			type: "transfer",
			playback: { ...playback, index: 20 },
		}),
	).toBeNull();
	expect(
		parseDeviceRequest({
			type: "transfer",
			playback: { ...playback, position: Infinity },
		}),
	).toBeNull();
	expect(
		parseDeviceRequest({ type: "control", command: "deleteAccount" }),
	).toBeNull();
	const parsed = parseDeviceRequest({
		type: "transfer",
		playback: {
			...playback,
			cookie: "secret",
			song: { ...song, cookie: "secret" },
		},
	});
	expect(parsed?.type).toBe("transfer");
	expect(JSON.stringify(parsed)).not.toContain("secret");
});

test("mobile Play here pulls a paused PC track with optional fields through the real PeerJS codec", async () => {
	const s = setup();
	const pc = await s.make();
	const phone = await s.make();
	const track = wireSong(song);
	const paused = {
		...playback,
		song: track,
		queue: [track],
		autoplayQueue: [wireSong({ ...song, id: "zyxwvutsrqp" })],
		playing: false,
	};
	pc.adapter.pause();
	pc.adapter.playback = () => paused;
	await phone.hub.refresh();
	await pc.hub.refresh();
	await phone.hub.move(pc.id, phone.id);
	expect(phone.track().song?.id).toBe(song.id);
	expect(phone.track().position).toBe(37);
	expect(phone.track().autoplayQueue[0].id).toBe("zyxwvutsrqp");
	expect(phone.playing()).toBe(false);
	expect(pc.playing()).toBe(false);
});

test("paused transfers remain paused and rejected autoplay keeps the source playing", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	await a.hub.refresh();
	a.adapter.pause();
	await a.hub.transfer(b.id);
	expect(a.playing()).toBe(false);
	expect(b.playing()).toBe(false);
	expect(b.track().position).toBe(37);
	a.adapter.control("resume");
	b.adapter.start = async () => {
		throw new Error("Autoplay blocked");
	};
	await expect(a.hub.transfer(b.id)).rejects.toThrow("Autoplay blocked");
	expect(a.playing()).toBe(true);
	expect(b.playing()).toBe(false);
});

test("an unconfirmed destination pauses when the source disconnects", async () => {
	const s = setup();
	const a = await s.make();
	const b = await s.make();
	await a.hub.refresh();
	const conn = a.peer.connect(b.id);
	await new Promise<void>((resolve) => {
		conn.on("open", () =>
			conn.send({
				version: 1,
				token: s.rows.get(b.id)?.connection_token,
				request: { type: "transfer", playback },
			}),
		);
		conn.on("data", () => {
			expect(b.playing()).toBe(true);
			conn.close();
			resolve();
		});
	});
	expect(a.playing()).toBe(true);
	expect(b.playing()).toBe(false);
});
