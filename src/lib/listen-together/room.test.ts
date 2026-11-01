import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Peer, PeerOptions } from "peerjs";
import {
	defaultPermissions,
	type GuestPermissions,
	type PermissionCategory,
	type PermissionsStorage,
	queueKey,
	type RoomAction,
} from "./guest-permissions";
import { generateRoomIdentity, type RoomIdentity } from "./identity";
import type { JoinSettings, JoinSettingsStorage } from "./join-settings";
import type { RoomPlayback } from "./protocol";
import { ListenRoom, type RoomState } from "./room";

class Channel extends EventEmitter {
	sent: string[] = [];
	open = false;
	dataChannel = { bufferedAmount: 0 };
	remote!: Channel;
	constructor(readonly peer: string) {
		super();
	}
	send(data: unknown) {
		if (typeof data === "string") this.sent.push(data);
		queueMicrotask(() => {
			if (this.remote.open) this.remote.emit("data", data);
		});
	}
	close() {
		if (!this.open) return;
		this.open = this.remote.open = false;
		this.emit("close");
		this.remote.emit("close");
	}
}
class Network {
	peers = new Map<string, FakePeer>();
	create = (_options: PeerOptions): Peer => {
		const peer = new FakePeer(`peer${this.peers.size + 1}`, this);
		this.peers.set(peer.id, peer);
		queueMicrotask(() => peer.emit("open", peer.id));
		return peer as unknown as Peer;
	};
}
class FakePeer extends EventEmitter {
	destroyed = false;
	disconnected = false;
	channels: Channel[] = [];
	constructor(
		readonly id: string,
		readonly network: Network,
	) {
		super();
	}
	connect(id: string) {
		const remote = this.network.peers.get(id);
		if (!remote) throw new Error("No peer");
		const a = new Channel(id);
		const b = new Channel(this.id);
		a.remote = b;
		b.remote = a;
		this.channels.push(a);
		remote.channels.push(b);
		queueMicrotask(() => {
			remote.emit("connection", b);
			a.open = b.open = true;
			b.emit("open");
			a.emit("open");
		});
		return a;
	}
	destroy() {
		this.destroyed = true;
		for (const channel of this.channels) channel.close();
	}
	reconnect() {
		this.disconnected = false;
		this.emit("open", this.id);
	}
}
const flush = async () => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};
const rooms: ListenRoom[] = [];
afterEach(() => {
	for (const room of rooms) room.leave();
	rooms.length = 0;
});
const profile = (username: string) => ({ username, avatar: null });
function memorySettings(): JoinSettingsStorage {
	let value: JoinSettings = { policy: "manual", people: [] };
	return {
		read: () => structuredClone(value),
		write: (next) => {
			value = structuredClone(next);
		},
	};
}
function until(
	room: ListenRoom,
	predicate: (state: RoomState) => boolean,
): Promise<void> {
	if (predicate(room.getSnapshot())) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			stop();
			reject(new Error("Room did not reach expected state"));
		}, 3000);
		const stop = room.subscribe(() => {
			if (predicate(room.getSnapshot())) {
				clearTimeout(timeout);
				stop();
				resolve();
			}
		});
	});
}
function memoryPermissions(): PermissionsStorage {
	let permissions: GuestPermissions = {
		select: "suggest",
		add: "suggest",
		skip: "deny",
		remove: "deny",
		reorder: "deny",
		playback: "deny",
		seek: "deny",
		repeat: "deny",
	};
	return {
		read: () => ({ ...permissions }),
		write: (next) => {
			permissions = { ...next };
		},
	};
}
const create = (
	network: Network,
	identity = generateRoomIdentity(),
	settings = memorySettings(),
	permissions = memoryPermissions(),
	resolveAccount: (fingerprint: string) => Promise<string | null> = async () =>
		null,
) => {
	const room = new ListenRoom(
		network.create,
		() => identity,
		settings,
		permissions,
		resolveAccount,
	);
	rooms.push(room);
	return room;
};
const state: Omit<RoomPlayback, "revision" | "sentAt"> = {
	instance: "track1",
	queue: [
		{ id: "abcdefghijk", title: "Test", artist: "Artist", thumbnail: "" },
	],
	autoplayQueue: [],
	autoplayEnabled: false,
	index: 0,
	song: { id: "abcdefghijk", title: "Test", artist: "Artist", thumbnail: "" },
	position: 25,
	playing: true,
	repeatMode: "off",
};

describe("PeerJS room lifecycle", () => {
	test("guest audio choice survives joining and reconnecting without changing host permissions", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await until(host, (s) => s.status === "hosting");
		guest.setGuestAudio("remote");
		await guest.connect(profile("Remote"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length === 1);
		host.approve(guest.getSnapshot().selfId as string, true);
		await until(guest, (s) => s.status === "connected");
		expect(guest.getSnapshot().guestAudio).toBe("remote");
		expect(guest.requestAction({ type: "pause" })).toBe("denied");
		guest.setGuestAudio("listen");
		expect(guest.getSnapshot().guestAudio).toBe("listen");
		expect(guest.requestAction({ type: "pause" })).toBe("denied");
		guest.leave();
		expect(guest.getSnapshot().guestAudio).toBe("listen");
	});
	test("trusting an account admits a second device and forgetting it revokes both", async () => {
		const network = new Network();
		const first = await generateRoomIdentity();
		const second = await generateRoomIdentity();
		const account = "11111111-1111-4111-8111-111111111111";
		const lookup = async (key: string) =>
			[first.fingerprint, second.fingerprint].includes(key) ? account : null;
		const host = create(
			network,
			generateRoomIdentity(),
			memorySettings(),
			memoryPermissions(),
			lookup,
		);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		const a = create(network, Promise.resolve(first));
		await a.connect(profile("Friend phone"), host.getSnapshot().invite);
		await until(a, (s) => s.status === "connected");
		host.trustPerson(a.getSnapshot().selfId as string);
		expect(host.getSnapshot().trustedPeople.map((p) => p.fingerprint)).toEqual([
			`account:${account}`,
		]);
		host.setJoinPolicy("trusted-only");
		a.leave();
		const b = create(network, Promise.resolve(second));
		await b.connect(profile("Friend computer"), host.getSnapshot().invite);
		await until(b, (s) => s.status === "connected");
		expect(host.getSnapshot().pending).toHaveLength(0);
		host.forgetPerson(`account:${account}`);
		b.leave();
		await a.connect(profile("Friend phone"), host.getSnapshot().invite);
		await until(a, (s) => s.status === "error");
		expect(a.getSnapshot().error).toContain("trusted devices");
		await b.connect(profile("Friend computer"), host.getSnapshot().invite);
		await until(b, (s) => s.status === "error");
	});

	test("a host automatically recognizes its own account's other device", async () => {
		const network = new Network();
		const accountId = "22222222-2222-4222-8222-222222222222";
		const ownIdentity = { ...(await generateRoomIdentity()), accountId };
		const otherIdentity = await generateRoomIdentity();
		const host = create(
			network,
			Promise.resolve(ownIdentity),
			memorySettings(),
			memoryPermissions(),
			async (key) => (key === otherIdentity.fingerprint ? accountId : null),
		);
		host.setJoinPolicy("trusted-only");
		await host.connect(profile("Me"));
		const other = create(network, Promise.resolve(otherIdentity));
		await other.connect(profile("My other device"), host.getSnapshot().invite);
		await until(other, (s) => s.status === "connected");
		expect(host.getSnapshot().trustedPeople).toEqual([]);
	});

	test("account lookup failure cannot admit an untrusted signed device", async () => {
		const network = new Network();
		const settings = memorySettings();
		settings.write({
			policy: "trusted-only",
			people: [
				{
					fingerprint: "account:11111111-1111-4111-8111-111111111111",
					username: "Friend",
				},
			],
		});
		const host = create(
			network,
			generateRoomIdentity(),
			settings,
			memoryPermissions(),
			async () => {
				throw new Error("offline");
			},
		);
		await host.connect(profile("Host"));
		const stranger = create(network);
		await stranger.connect(profile("Friend"), host.getSnapshot().invite);
		await until(stranger, (s) => s.status === "error");
		expect(host.getSnapshot().members).toHaveLength(1);
	});

	test("a guest's fresh trust proof resolves the account instead of trusting a roster claim", async () => {
		const network = new Network();
		const friendIdentity = await generateRoomIdentity();
		const accountId = "33333333-3333-4333-8333-333333333333";
		const host = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		const friend = create(network, Promise.resolve(friendIdentity));
		await friend.connect(profile("Friend"), host.getSnapshot().invite);
		await until(friend, (s) => s.status === "connected");
		const guest = create(
			network,
			generateRoomIdentity(),
			memorySettings(),
			memoryPermissions(),
			async (key) => (key === friendIdentity.fingerprint ? accountId : null),
		);
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(
			guest,
			(s) => s.status === "connected" && s.members.length === 3,
		);
		guest.trustPerson(friend.getSnapshot().selfId as string);
		await until(guest, (s) => s.trustedPeople.length === 1);
		expect(guest.getSnapshot().trustedPeople[0].fingerprint).toBe(
			`account:${accountId}`,
		);
		expect(host.getSnapshot().trustedPeople).toEqual([]);
	});

	test("attributes approved and allowed additions to the verified guest and syncs autoplay updates", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		host.broadcastPlayback({
			...state,
			autoplayQueue: state.queue,
			autoplayEnabled: true,
		});
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected" && !!s.playback);
		expect(guest.getSnapshot().playback?.autoplayQueue).toEqual(state.queue);
		const applied: RoomAction[] = [];
		host.setActionHandler((action) => {
			applied.push(action);
		});
		for (const mode of ["allow", "suggest"] as const) {
			host.setGuestPermissions({ ...defaultPermissions, add: mode });
			await flush();
			guest.requestAction({
				type: "add",
				songs: state.queue.map((song) => ({ ...song, addedBy: "Host" })),
			});
			await flush();
			if (mode === "suggest") {
				host.resolveRequest(host.getSnapshot().requests[0].id, true);
				await flush();
			}
		}
		expect(
			applied.map((action) => action.type === "add" && action.songs[0].addedBy),
		).toEqual(["Guest", "Guest"]);
		host.broadcastPlayback({ ...state, autoplayEnabled: false });
		await flush();
		expect(guest.getSnapshot().playback?.autoplayEnabled).toBe(false);
		expect(guest.getSnapshot().playback?.autoplayQueue).toEqual([]);
	});
	test("trusted auto-approval admits friends and leaves strangers awaiting approval", async () => {
		const network = new Network();
		const identity = generateRoomIdentity();
		const friend = await identity;
		const host = create(
			network,
			generateRoomIdentity(),
			{
				read: () => ({
					policy: "trusted",
					people: [{ fingerprint: friend.fingerprint, username: "Friend" }],
				}),
				write: () => undefined,
			},
			{ read: () => ({ ...defaultPermissions }), write: () => undefined },
		);
		const known = create(network, identity);
		const stranger = create(network);
		await host.connect(profile("Host"));
		await known.connect(profile("Friend"), host.getSnapshot().invite);
		await until(known, (s) => s.status === "connected");
		await stranger.connect(profile("New listener"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length === 1);
		expect(stranger.getSnapshot().status).toBe("connecting");
		expect(host.getSnapshot().members).toHaveLength(2);
		expect(known.getSnapshot().permissions).toEqual(defaultPermissions);
		host.approve(host.getSnapshot().pending[0].id, true);
		await until(stranger, (s) => s.status === "connected");
	});
	test("guests can verify and personally trust the host and other guests", async () => {
		const network = new Network();
		const host = create(network);
		const a = create(network);
		const b = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		await a.connect(profile("Alice"), host.getSnapshot().invite);
		await until(a, (s) => s.status === "connected");
		await b.connect(profile("Bob"), host.getSnapshot().invite);
		await until(a, (s) => s.members.length === 3);
		const hostId = host.getSnapshot().selfId as string;
		const bobId = b.getSnapshot().selfId as string;
		a.trustPerson(hostId);
		await until(a, (s) => s.trustedPeople.length === 1);
		a.trustPerson(bobId);
		await until(a, (s) => s.trustedPeople.length === 2);
		expect(
			a.getSnapshot().trustedPeople.map((person) => person.username),
		).toEqual(["Host", "Bob"]);
		expect(host.getSnapshot().trustedPeople).toHaveLength(0);
		expect(b.getSnapshot().trustedPeople).toHaveLength(0);
		const bobKey = a.getSnapshot().trustedPeople[1].fingerprint;
		a.forgetPerson(bobKey);
		expect(a.getSnapshot().trustedPeople).toHaveLength(1);
		a.trustPerson(a.getSnapshot().selfId as string);
		expect(a.getSnapshot().verifyingTrust).toHaveLength(0);
	});
	test("a person trusted as a guest can automatically join when that guest later hosts", async () => {
		const network = new Network();
		const originalHost = create(network);
		const guest = create(network);
		originalHost.setJoinPolicy("everyone");
		await originalHost.connect(profile("Original host"));
		await guest.connect(profile("Guest"), originalHost.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		guest.trustPerson(originalHost.getSnapshot().selfId as string);
		await until(guest, (s) => s.trustedPeople.length === 1);
		guest.leave();
		originalHost.leave();
		guest.setJoinPolicy("trusted");
		await guest.connect(profile("New host"));
		await originalHost.connect(
			profile("Returning person"),
			guest.getSnapshot().invite,
		);
		await until(originalHost, (s) => s.status === "connected");
		expect(guest.getSnapshot().pending).toHaveLength(0);
		expect(guest.getSnapshot().members).toHaveLength(2);
	});
	test("a guest does not trust an unproven fingerprint supplied in a roster", async () => {
		const network = new Network();
		const host = create(network);
		const a = create(network);
		const b = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		await a.connect(profile("Alice"), host.getSnapshot().invite);
		await until(a, (s) => s.status === "connected");
		await b.connect(profile("Bob"), host.getSnapshot().invite);
		await until(a, (s) => s.members.length === 3);
		const bobId = b.getSnapshot().selfId as string;
		const tampered = host
			.getSnapshot()
			.members.map((member) =>
				member.id === bobId
					? { ...member, fingerprint: "a".repeat(64) }
					: member,
			);
		[...network.peers.values()][0].channels[0].send(
			JSON.stringify({ type: "members", members: tampered }),
		);
		await flush();
		a.trustPerson(bobId);
		await until(a, (s) => s.verifyingTrust.length === 0);
		expect(a.getSnapshot().trustedPeople).toHaveLength(0);
		expect(a.getSnapshot().notice?.message).toContain("could not be verified");
	});
	test("leaving during identity verification cannot save trust afterward", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		guest.trustPerson(host.getSnapshot().selfId as string);
		guest.leave();
		await flush();
		expect(guest.getSnapshot().trustedPeople).toHaveLength(0);
		expect(guest.getSnapshot().verifyingTrust).toHaveLength(0);
	});
	test("guests can suggest songs when the host has no current song or queue", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		host.broadcastPlayback({
			...state,
			instance: "empty",
			song: null,
			queue: [],
			index: -1,
			position: 0,
			playing: false,
		});
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		await flush();
		expect(
			guest.requestAction({
				type: "add",
				songs: [state.song as NonNullable<typeof state.song>],
			}),
		).toBe("sent");
		await until(host, (s) => s.requests.length === 1);
		expect(host.getSnapshot().requests[0].song?.title).toBe("Test");
		expect(host.getSnapshot().playback?.queue).toHaveLength(0);
		const applied: RoomAction[] = [];
		host.setActionHandler((action) => {
			applied.push(action);
		});
		host.resolveRequest(host.getSnapshot().requests[0].id, true);
		await flush();
		expect(applied[0].type).toBe("add");
	});
	test("each guest action supports allow, request approval, and deny", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		host.broadcastPlayback(state);
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		await flush();
		const applied: RoomAction[] = [];
		host.setActionHandler((action) => {
			applied.push(action);
		});
		const actions: [PermissionCategory, RoomAction][] = [
			[
				"select",
				{ type: "play", song: state.song as NonNullable<typeof state.song> },
			],
			["add", { type: "add", songs: state.queue }],
			["skip", { type: "next" }],
			["remove", { type: "remove", index: 0 }],
			["reorder", { type: "shuffle" }],
			["playback", { type: "pause" }],
			["seek", { type: "seek", position: 20 }],
			["repeat", { type: "repeat", mode: "all" }],
		];
		for (const [category, action] of actions) {
			for (const mode of ["allow", "suggest", "deny"] as const) {
				host.setGuestPermissions({ ...defaultPermissions, [category]: mode });
				await flush();
				const previous = applied.length;
				expect(guest.requestAction(action)).toBe(
					mode === "deny" ? "denied" : "sent",
				);
				await flush();
				if (mode === "suggest") {
					expect(applied).toHaveLength(previous);
					expect(host.getSnapshot().requests).toHaveLength(1);
					host.resolveRequest(host.getSnapshot().requests[0].id, true);
					await flush();
				}
				expect(applied).toHaveLength(previous + (mode === "deny" ? 0 : 1));
			}
		}
	});
	test("the host rejects raw disallowed commands and permission changes from a guest", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		host.broadcastPlayback(state);
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		await flush();
		const applied: RoomAction[] = [];
		host.setActionHandler((action) => {
			applied.push(action);
		});
		const allAllow = Object.fromEntries(
			Object.keys(defaultPermissions).map((key) => [key, "allow"]),
		) as GuestPermissions;
		const channel = [...network.peers.values()][1].channels[0];
		channel.send(
			JSON.stringify({ type: "permissions", permissions: allAllow }),
		);
		channel.send(
			JSON.stringify({
				type: "action",
				id: "bypass",
				action: { type: "remove", index: 0 },
				context: { instance: state.instance, queueKey: queueKey(state.queue) },
			}),
		);
		await flush();
		expect(host.getSnapshot().permissions.remove).toBe("deny");
		expect(applied).toHaveLength(0);
		expect(guest.getSnapshot().notice?.message).toContain("does not allow");
	});
	test("pending queue and seek requests cannot act on a different track", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		host.setGuestPermissions({
			...defaultPermissions,
			seek: "suggest",
			remove: "suggest",
		});
		await host.connect(profile("Host"));
		host.broadcastPlayback(state);
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		await flush();
		const applied: RoomAction[] = [];
		host.setActionHandler((action) => {
			applied.push(action);
		});
		guest.requestAction({ type: "seek", position: 50 });
		guest.requestAction({ type: "remove", index: 0 });
		await flush();
		expect(host.getSnapshot().requests).toHaveLength(2);
		host.broadcastPlayback({ ...state, instance: "next-track" });
		for (const request of [...host.getSnapshot().requests])
			host.resolveRequest(request.id, true);
		await flush();
		expect(applied).toHaveLength(0);
		expect(guest.getSnapshot().notice?.message).toContain("track changed");
	});
	test("denying an action cancels pending requests and persists permission choices", async () => {
		const network = new Network();
		const store = memoryPermissions();
		const host = create(
			network,
			generateRoomIdentity(),
			memorySettings(),
			store,
		);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		guest.suggestSongs(state.queue);
		await until(host, (s) => s.requests.length > 0);
		host.setGuestPermissions({ ...defaultPermissions, add: "deny" });
		await flush();
		expect(host.getSnapshot().requests).toHaveLength(0);
		expect(
			create(
				network,
				generateRoomIdentity(),
				memorySettings(),
				store,
			).getSnapshot().permissions.add,
		).toBe("deny");
	});
	test("storage failures cannot silently enable auto-approval or lose a pending request", async () => {
		const storage = memorySettings();
		storage.write = () => {
			throw new Error("Storage unavailable");
		};
		const network = new Network();
		const host = create(network, generateRoomIdentity(), storage);
		const guest = create(network);
		expect(() => host.setJoinPolicy("everyone")).toThrow("Storage unavailable");
		expect(host.getSnapshot().joinPolicy).toBe("manual");
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		expect(() =>
			host.approve(host.getSnapshot().pending[0].id, true, true),
		).toThrow("Storage unavailable");
		expect(host.getSnapshot().pending).toHaveLength(1);
		expect(host.getSnapshot().trustedPeople).toHaveLength(0);
		expect(guest.getSnapshot().status).not.toBe("connected");
	});
	test("identity storage failures stop the connection before a peer is created", async () => {
		const network = new Network();
		const room = new ListenRoom(
			network.create,
			async () => {
				throw new Error("Identity unavailable");
			},
			memorySettings(),
		);
		rooms.push(room);
		await room.connect(profile("Guest"));
		expect(room.getSnapshot().status).toBe("error");
		expect(network.peers.size).toBe(0);
	});
	test("auto-approve everyone admits a verified device without trusting it", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "connected");
		expect(host.getSnapshot().pending).toHaveLength(0);
		expect(host.getSnapshot().trustedPeople).toHaveLength(0);
	});
	test("trusted-only persists known keys across rooms and rejects a renamed unknown device", async () => {
		const network = new Network();
		const saved = memorySettings();
		const friendIdentity = generateRoomIdentity();
		const host = create(network, generateRoomIdentity(), saved);
		const friend = create(network, friendIdentity);
		await host.connect(profile("Host"));
		await friend.connect(profile("Friend"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.approve(host.getSnapshot().pending[0].id, true, true);
		await until(friend, (s) => s.status === "connected");
		const key = host.getSnapshot().trustedPeople[0].fingerprint;
		host.setJoinPolicy("trusted-only");
		host.leave();
		friend.leave();
		const restartedHost = create(network, generateRoomIdentity(), saved);
		expect(restartedHost.getSnapshot().joinPolicy).toBe("trusted-only");
		await restartedHost.connect(profile("Host"));
		await friend.connect(
			profile("New name"),
			restartedHost.getSnapshot().invite,
		);
		await until(friend, (s) => s.status === "connected");
		expect(restartedHost.getSnapshot().members[1].fingerprint).toBe(key);
		expect(restartedHost.getSnapshot().pending).toHaveLength(0);
		const stranger = create(network);
		await stranger.connect(
			profile("Friend"),
			restartedHost.getSnapshot().invite,
		);
		await until(stranger, (s) => s.status === "error");
		expect(stranger.getSnapshot().error).toContain("trusted devices");
	});
	test("copying a trusted public key fails signature verification", async () => {
		const network = new Network();
		const host = create(network);
		const friend = await generateRoomIdentity();
		const attacker = await generateRoomIdentity();
		const spoofed: RoomIdentity = { ...attacker, publicKey: friend.publicKey };
		const impostor = create(network, Promise.resolve(spoofed));
		host.setJoinPolicy("everyone");
		await host.connect(profile("Host"));
		await impostor.connect(profile("Friend"), host.getSnapshot().invite);
		await until(impostor, (s) => s.status === "error");
		expect(impostor.getSnapshot().error).toContain(
			"verify your device identity",
		);
		expect(host.getSnapshot().members).toHaveLength(1);
	});
	test("forgetting a trusted key prevents its next trusted-only join", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.approve(host.getSnapshot().pending[0].id, true, true);
		await until(guest, (s) => s.status === "connected");
		const fingerprint = host.getSnapshot().trustedPeople[0].fingerprint;
		host.setJoinPolicy("trusted-only");
		host.forgetPerson(fingerprint);
		guest.leave();
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(guest, (s) => s.status === "error");
		expect(guest.getSnapshot().error).toContain("trusted devices");
	});
	test("changing policies applies to people waiting for approval", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.setJoinPolicy("everyone");
		await until(guest, (s) => s.status === "connected");
		expect(host.getSnapshot().pending).toHaveLength(0);
	});
	test("requires host approval before sharing state and propagates profile edits", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await flush();
		host.broadcastPlayback(state);
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		expect(host.getSnapshot().pending[0].profile.username).toBe("Guest");
		expect(guest.getSnapshot().playback).toBeNull();
		guest.setStatus("buffering");
		guest.setProfile(profile("Updated before joining"));
		await until(
			host,
			(s) => s.pending[0]?.profile.username === "Updated before joining",
		);
		expect(host.getSnapshot().pending[0].profile.username).toBe(
			"Updated before joining",
		);
		host.approve(host.getSnapshot().pending[0].id, true);
		await flush();
		expect(guest.getSnapshot().status).toBe("connected");
		expect(guest.getSnapshot().members).toHaveLength(2);
		expect(guest.getSnapshot().playback?.position).toBe(25);
		expect(guest.getSnapshot().clockOffset).not.toBeNull();
		// Reopening signaling must not reset an established room's membership.
		[...network.peers.values()][0].emit("open", "peer1");
		await flush();
		expect(host.getSnapshot().members).toHaveLength(2);
		guest.setProfile(profile("New name"));
		await flush();
		expect(host.getSnapshot().members[1].profile.username).toBe("New name");
		expect(guest.getSnapshot().members[1].profile.username).toBe("New name");
		guest.suggestSongs([state.song as NonNullable<typeof state.song>]);
		await flush();
		expect(host.getSnapshot().requests[0].song?.id).toBe("abcdefghijk");
		expect(host.getSnapshot().requests[0].profile.username).toBe("New name");
		host.resolveRequest(host.getSnapshot().requests[0].id, false);
		expect(host.getSnapshot().requests).toHaveLength(0);
	});
	test("rejects stale playback updates and guests cannot change host playback", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.approve(host.getSnapshot().pending[0].id, true);
		await flush();
		host.broadcastPlayback(state);
		await flush();
		const stale = host.getSnapshot().playback;
		host.broadcastPlayback({ ...state, position: 45 });
		await flush();
		const hostPeer = [...network.peers.values()][0];
		const session = JSON.parse(
			hostPeer.channels[0].sent.find(
				(raw) => JSON.parse(raw).type === "welcome",
			) || "{}",
		).session;
		hostPeer.channels[0].send(
			JSON.stringify({ type: "state", session, playback: stale }),
		);
		const guestPeer = [...network.peers.values()][1];
		guestPeer.channels[0].send(
			JSON.stringify({
				type: "state",
				session: "wrong-room",
				playback: { ...stale, position: 1 },
			}),
		);
		await flush();
		expect(host.getSnapshot().playback?.position).toBe(45);
		expect(guest.getSnapshot().playback?.position).toBe(45);
	});
	test("declining a request and ending a room clean up guest connections", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.approve(host.getSnapshot().pending[0].id, false);
		await flush();
		expect(guest.getSnapshot().role).toBeNull();
		expect(guest.getSnapshot().error).toContain("declined");
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.approve(host.getSnapshot().pending[0].id, true);
		await flush();
		host.leave();
		await flush();
		expect(guest.getSnapshot().role).toBeNull();
	});
	test("invalid profiles and invitation codes never create a peer", async () => {
		const network = new Network();
		const room = create(network);
		await expect(room.connect(profile(""))).rejects.toThrow("Confirm");
		await expect(room.connect(profile("Name"), "bad-code")).rejects.toThrow(
			"valid",
		);
		expect(network.peers.size).toBe(0);
	});
	test("a dropped guest channel reconnects and restores state without another approval", async () => {
		const network = new Network();
		const host = create(network);
		const guest = create(network);
		await host.connect(profile("Host"));
		await guest.connect(profile("Guest"), host.getSnapshot().invite);
		await until(host, (s) => s.pending.length > 0);
		host.approve(host.getSnapshot().pending[0].id, true);
		host.broadcastPlayback(state);
		await flush();
		[...network.peers.values()][1].channels[0].close();
		expect(guest.getSnapshot().status).toBe("reconnecting");
		await until(guest, (s) => s.status === "connected");
		await flush();
		expect(guest.getSnapshot().status).toBe("connected");
		expect(host.getSnapshot().pending).toHaveLength(0);
		expect(guest.getSnapshot().playback?.song?.id).toBe("abcdefghijk");
	});
});
