import type { DataConnection, Peer, PeerOptions } from "peerjs";
import { useSyncExternalStore } from "react";
import type { Song } from "@/contexts/player-context";
import {
	type ActionContext,
	actionCategory,
	actionSong,
	defaultPermissions,
	type GuestPermissions,
	type PermissionsStorage,
	permissionsStorage,
	queueKey,
	type RoomAction,
	type RoomRequest,
	validPermissions,
} from "./guest-permissions";
import {
	createNonce,
	getRoomIdentity,
	type JoinChallenge,
	type RoomIdentity,
	verifyIdentity,
} from "./identity";
import {
	type JoinPolicy,
	type JoinSettingsStorage,
	joinSettingsStorage,
	type TrustedPerson,
	validPolicy,
} from "./join-settings";
import { type RoomProfile, validProfile } from "./profile";
import { attributeAction } from "./queue-attribution";
import {
	type Participant,
	parseInvite,
	parseMessage,
	parseRoomAction,
	type RoomMessage,
	type RoomPlayback,
} from "./protocol";

export interface RoomState {
	selfId: string | null;
	verifyingTrust: string[];
	role: "host" | "guest" | null;
	status:
		| "idle"
		| "connecting"
		| "hosting"
		| "connected"
		| "reconnecting"
		| "error";
	invite: string;
	members: Participant[];
	pending: Participant[];
	requests: RoomRequest[];
	permissions: GuestPermissions;
	notice: { id: string; message: string } | null;
	playback: RoomPlayback | null;
	clockOffset: number | null;
	error: string | null;
	joinPolicy: JoinPolicy;
	trustedPeople: TrustedPerson[];
}
const initial = (): RoomState => ({
	selfId: null,
	verifyingTrust: [],
	role: null,
	status: "idle",
	invite: "",
	members: [],
	pending: [],
	requests: [],
	permissions: { ...defaultPermissions },
	notice: null,
	playback: null,
	clockOffset: null,
	error: null,
	joinPolicy: "everyone",
	trustedPeople: [],
});
const randomToken = () =>
	Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
const now = () => performance.now();

/** One room per app window. PeerJS only starts after a confirmed profile. */
export class ListenRoom {
	constructor(
		private createPeer?: (options: PeerOptions) => Peer,
		private identityProvider: () => Promise<RoomIdentity> = getRoomIdentity,
		private settings: JoinSettingsStorage = joinSettingsStorage,
		private permissionStorage: PermissionsStorage = permissionsStorage,
	) {
		const saved = settings.read();
		this.state = {
			...initial(),
			permissions: permissionStorage.read(),
			joinPolicy: saved.policy,
			trustedPeople: saved.people,
		};
	}
	private actionHandler:
		| ((action: RoomAction, context: ActionContext) => Promise<void> | void)
		| null = null;
	private actionChain: Promise<void> = Promise.resolve();
	private seenActions = new Map<DataConnection, Set<string>>();
	private state = initial();
	private listeners = new Set<() => void>();
	private peer: Peer | null = null;
	private channels = new Map<string, DataConnection>();
	private admitted = new Map<string, string>();
	private approvedKeys = new Set<string>();
	private verified = new Map<DataConnection, string>();
	private challenges = new Map<
		DataConnection,
		{
			challenge: JoinChallenge;
			publicKey: string;
			profile: RoomProfile;
			verifying: boolean;
		}
	>();
	private sentProfiles = new Map<DataConnection, RoomProfile>();
	private identity: RoomIdentity | null = null;
	private trustChallenges = new Map<
		string,
		{
			target: string;
			fingerprint: string;
			challenge: JoinChallenge;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private timers = new Set<ReturnType<typeof setTimeout>>();
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private generation = 0;
	private token = "";
	private hostId = "";
	private session = "";
	private profile: RoomProfile | null = null;
	private pings = new Map<number, number>();
	private pingId = 0;
	private bestRtt = Infinity;
	private lastHeard = 0;
	private retry = 0;
	private revision = 0;
	private structure = "";
	private localStatus: Participant["status"] = "paused";

	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private update(patch: Partial<RoomState>) {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	private later(fn: () => void, ms: number) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			fn();
		}, ms);
		this.timers.add(timer);
		return timer;
	}
	private send(connection: DataConnection, message: RoomMessage) {
		if (
			!connection.open ||
			(connection.dataChannel?.bufferedAmount ?? 0) > 2_000_000
		)
			return;
		try {
			connection.send(JSON.stringify(message));
		} catch {
			connection.close();
		}
	}
	private broadcast(message: RoomMessage) {
		for (const connection of this.channels.values())
			if (this.isAdmitted(connection)) this.send(connection, message);
	}
	private publishMembers() {
		this.broadcast({ type: "members", members: this.state.members });
	}

	async connect(profile: RoomProfile, invite?: string) {
		if (!validProfile(profile))
			throw new Error("Confirm your room profile first.");
		const parsed = invite === undefined ? null : parseInvite(invite);
		if (invite !== undefined && !parsed)
			throw new Error("Enter a valid YuMusic room code.");
		this.leave();
		const generation = this.generation;
		this.profile = profile;
		this.token = parsed?.token ?? randomToken();
		this.hostId = parsed?.host ?? "";
		this.session = crypto.randomUUID();
		this.update({ role: parsed ? "guest" : "host", status: "connecting" });
		try {
			this.identity = await this.identityProvider();
			if (generation !== this.generation) return;
			let makePeer = this.createPeer;
			if (!makePeer) {
				const { default: PeerClass } = await import("peerjs");
				makePeer = (options) => new PeerClass(options);
			}
			const options: PeerOptions = { debug: 0 };
			const server = import.meta.env.VITE_LISTEN_PEER_SERVER;
			if (server) {
				const url = new URL(server);
				if (url.protocol !== "https:")
					throw new Error("The room server must use HTTPS.");
				Object.assign(options, {
					host: url.hostname,
					port: Number(url.port || 443),
					path: url.pathname,
					secure: true,
				});
			}
			// Optional endpoint supplies short-lived TURN credentials; no secret in the bundle.
			if (import.meta.env.VITE_LISTEN_ICE_URL) {
				const response = await fetch(import.meta.env.VITE_LISTEN_ICE_URL, {
					signal: AbortSignal.timeout(10000),
				});
				if (!response.ok)
					throw new Error("Could not load room connection settings.");
				options.config = { iceServers: await response.json() };
			}
			if (generation !== this.generation) return;
			if (!this.createPeer && typeof RTCPeerConnection === "undefined")
				throw new Error(
					"This device does not support Listen Together connections.",
				);
			const peer = makePeer(options);
			this.peer = peer;
			let opened = false;
			const timeout = this.later(() => {
				if (this.state.status === "connecting")
					this.fail(
						"Room connection timed out. Check your connection and room code.",
					);
			}, 30000);
			peer.on("open", (id) => {
				if (generation !== this.generation) return;
				if (opened) {
					if (this.state.role === "guest") this.connectHost();
					return;
				}
				opened = true;
				this.update({ selfId: id });
				clearTimeout(timeout);
				this.timers.delete(timeout);
				if (this.state.role === "host") {
					this.hostId = id;
					this.update({
						status: "hosting",
						invite: `yu1.${id}.${this.token}`,
						members: [
							{
								id,
								profile: this.profile ?? profile,
								status: "paused",
								fingerprint: this.identity?.fingerprint,
							},
						],
					});
				} else this.connectHost();
				if (!this.heartbeat)
					this.heartbeat = setInterval(() => this.tick(), 2000);
			});
			peer.on("connection", (conn) => {
				if (generation !== this.generation || this.state.role !== "host") {
					conn.close();
					return;
				}
				this.attach(conn, true);
			});
			peer.on("disconnected", () => {
				if (generation !== this.generation) return;
				this.later(() => {
					if (!peer.destroyed && peer.disconnected) peer.reconnect();
				}, 1500);
			});
			peer.on("error", (error) => {
				if (generation !== this.generation) return;
				if (["network", "socket-error", "socket-closed"].includes(error.type)) {
					if (peer.disconnected)
						this.later(() => {
							if (!peer.destroyed) peer.reconnect();
						}, 2000);
					return;
				}
				if (error.type === "peer-unavailable" && this.state.role === "guest") {
					const connection = this.channels.get(this.hostId);
					if (connection) {
						this.channels.delete(this.hostId);
						connection.close();
					}
					this.reconnect();
					return;
				}
				this.fail(
					"Could not connect to the room. The device or network may not support this connection.",
				);
			});
		} catch (error) {
			if (generation === this.generation)
				this.fail(
					error instanceof Error
						? error.message
						: "Could not create the room connection.",
				);
		}
	}

	private connectHost() {
		if (!this.peer || this.peer.destroyed || this.channels.has(this.hostId))
			return;
		const connection = this.peer.connect(this.hostId, {
			reliable: true,
			serialization: "binary",
		});
		this.channels.set(this.hostId, connection);
		this.attach(connection, false);
	}
	private attach(connection: DataConnection, incoming: boolean) {
		const generation = this.generation;
		if (incoming && this.channels.size >= 15) {
			connection.close();
			return;
		}
		if (incoming) {
			const previous = this.channels.get(connection.peer);
			if (previous && previous !== connection) previous.close();
			this.channels.set(connection.peer, connection);
		}
		let messages = 0;
		let windowStart = now();
		const timeout = this.later(
			() => {
				if (
					incoming
						? !this.isAdmitted(connection)
						: this.state.status !== "connected"
				)
					connection.close();
			},
			incoming ? 60000 : 30000,
		);
		connection.on("open", () => {
			if (!incoming) this.sayHello(connection);
		});
		connection.on("data", (raw) => {
			if (generation !== this.generation) return;
			if (now() - windowStart > 1000) {
				windowStart = now();
				messages = 0;
			}
			if (++messages > 30) {
				connection.close();
				return;
			}
			const message = parseMessage(raw);
			if (!message) {
				connection.close();
				return;
			}
			if (incoming)
				void this.fromGuest(connection, message).catch(() =>
					connection.close(),
				);
			else {
				this.lastHeard = now();
				this.fromHost(connection, message);
			}
		});
		connection.on("close", () => {
			clearTimeout(timeout);
			this.timers.delete(timeout);
			if (
				generation !== this.generation ||
				this.channels.get(connection.peer) !== connection
			)
				return;
			this.channels.delete(connection.peer);
			this.verified.delete(connection);
			this.challenges.delete(connection);
			this.sentProfiles.delete(connection);
			this.seenActions.delete(connection);
			this.admitted.delete(connection.peer);
			if (incoming) {
				this.update({
					members: this.state.members.filter((m) => m.id !== connection.peer),
					pending: this.state.pending.filter((m) => m.id !== connection.peer),
					requests: this.state.requests.filter(
						(r) => r.from !== connection.peer,
					),
				});
				this.publishMembers();
			} else this.reconnect();
		});
		connection.on("error", () => connection.close());
	}

	private isAdmitted(connection: DataConnection) {
		const fingerprint = this.verified.get(connection);
		return !!fingerprint && this.admitted.get(connection.peer) === fingerprint;
	}
	private sayHello(connection: DataConnection) {
		if (!this.profile || !this.identity) return;
		this.sentProfiles.set(connection, this.profile);
		this.send(connection, {
			type: "hello",
			version: 2,
			token: this.token,
			profile: this.profile,
			publicKey: this.identity.publicKey,
		});
	}
	private async fromGuest(connection: DataConnection, message: RoomMessage) {
		const id = connection.peer;
		if (message.type === "hello") {
			if (message.token !== this.token) {
				connection.close();
				return;
			}
			const challenge = {
				nonce: createNonce(),
				session: this.session,
				host: this.hostId,
				guest: id,
			};
			this.challenges.set(connection, {
				challenge,
				publicKey: message.publicKey,
				profile: message.profile,
				verifying: false,
			});
			this.send(connection, { type: "challenge", ...challenge });
			return;
		}
		if (message.type === "proof") {
			const pending = this.challenges.get(connection);
			if (
				!pending ||
				pending.verifying ||
				pending.challenge.nonce !== message.nonce
			)
				return;
			pending.verifying = true;
			const fingerprint = await verifyIdentity(
				pending.publicKey,
				pending.challenge,
				this.token,
				pending.profile,
				message.signature,
			);
			if (
				this.challenges.get(connection) !== pending ||
				this.channels.get(id) !== connection ||
				!connection.open
			)
				return;
			this.challenges.delete(connection);
			if (!fingerprint) {
				this.reject(connection, "Could not verify your device identity.");
				return;
			}
			this.verified.set(connection, fingerprint);
			const member: Participant = {
				id,
				profile: pending.profile,
				status: "paused",
				fingerprint,
			};
			this.update({
				pending: [...this.state.pending.filter((p) => p.id !== id), member],
			});
			this.applyJoinPolicy(id);
			return;
		}
		if (!this.isAdmitted(connection)) {
			connection.close();
			return;
		}
		if (
			message.type === "identity-request" &&
			message.challenge.session === this.session &&
			message.challenge.host === connection.peer
		) {
			if (message.challenge.guest === this.hostId)
				await this.answerTrustChallenge(connection, message.challenge);
			else {
				const target = this.channels.get(message.challenge.guest);
				if (target && this.isAdmitted(target)) this.send(target, message);
			}
			return;
		}
		if (
			message.type === "identity-proof" &&
			message.challenge.session === this.session &&
			message.challenge.guest === connection.peer
		) {
			const requester = this.channels.get(message.challenge.host);
			if (requester && this.isAdmitted(requester))
				this.send(requester, message);
			return;
		}
		if (message.type === "suggest") {
			this.receiveAction(
				connection,
				crypto.randomUUID(),
				{ type: "add", songs: [message.song] },
				this.actionContext(),
			);
		}
		if (message.type === "action")
			this.receiveAction(
				connection,
				message.id,
				message.action,
				message.context,
			);
		if (message.type === "ping")
			this.send(connection, {
				type: "pong",
				id: message.id,
				at: message.at,
				hostAt: now(),
			});
		if (message.type === "profile" || message.type === "status") {
			this.update({
				members: this.state.members.map((m) =>
					m.id !== id
						? m
						: {
								...m,
								...(message.type === "profile"
									? { profile: message.profile }
									: { status: message.status }),
							},
				),
			});
			this.publishMembers();
		}
	}
	approve(id: string, accept: boolean, remember = false) {
		if (this.state.role !== "host") return;
		const member = this.state.pending.find((p) => p.id === id);
		const connection = this.channels.get(id);
		if (!connection || !member || !this.verified.has(connection)) return;
		if (!accept || this.state.members.length >= 8) {
			this.update({ pending: this.state.pending.filter((p) => p.id !== id) });
			this.send(connection, {
				type: "end",
				reason: accept
					? "The room is full."
					: "The host declined your request.",
			});
			this.later(() => connection.close(), 200);
			return;
		}
		if (remember && member.fingerprint)
			this.rememberPerson(member.fingerprint, member.profile.username);
		this.update({ pending: this.state.pending.filter((p) => p.id !== id) });
		const fingerprint = this.verified.get(connection);
		if (!fingerprint) return;
		this.admitted.set(id, fingerprint);
		this.approvedKeys.add(fingerprint);
		this.welcome(connection, member.profile);
	}
	private reject(connection: DataConnection, reason: string) {
		this.update({
			pending: this.state.pending.filter((p) => p.id !== connection.peer),
		});
		this.send(connection, { type: "end", reason });
		this.later(() => connection.close(), 200);
	}
	private applyJoinPolicy(id: string) {
		const member = this.state.pending.find((p) => p.id === id);
		const connection = this.channels.get(id);
		if (
			!member?.fingerprint ||
			!connection ||
			this.verified.get(connection) !== member.fingerprint
		)
			return;
		const trusted = this.state.trustedPeople.some(
			(p) => p.fingerprint === member.fingerprint,
		);
		if (this.state.joinPolicy === "trusted-only" && !trusted) {
			this.reject(
				connection,
				"This room only accepts trusted devices. Ask the host to approve and trust you in manual mode first.",
			);
			return;
		}
		if (
			this.state.joinPolicy === "everyone" ||
			((this.state.joinPolicy === "trusted" ||
				this.state.joinPolicy === "trusted-only") &&
				trusted) ||
			this.approvedKeys.has(member.fingerprint)
		)
			this.approve(id, true);
	}
	setJoinPolicy(policy: JoinPolicy) {
		if (this.state.role === "guest" || !validPolicy(policy)) return;
		this.settings.write({ policy, people: this.state.trustedPeople });
		this.update({ joinPolicy: policy });
		for (const person of [...this.state.pending])
			this.applyJoinPolicy(person.id);
	}
	private rememberPerson(fingerprint: string, username: string) {
		const people = this.state.trustedPeople.filter(
			(p) => p.fingerprint !== fingerprint,
		);
		if (people.length >= 100)
			throw new Error("Remove a trusted device before adding another.");
		people.push({ fingerprint, username });
		this.settings.write({ policy: this.state.joinPolicy, people });
		this.update({ trustedPeople: people });
	}
	trustPerson(id: string) {
		const member = this.state.members.find((p) => p.id === id);
		if (!member || member.id === this.peer?.id) return;
		if (this.state.role === "guest") {
			if (
				this.state.status !== "connected" ||
				!member.fingerprint ||
				!this.peer
			)
				throw new Error("Wait until the room is connected.");
			if (this.state.verifyingTrust.includes(id)) return;
			const connection = this.channels.get(this.hostId);
			if (!connection?.open) throw new Error("The host is disconnected.");
			const challenge = {
				nonce: createNonce(),
				session: this.session,
				host: this.peer.id,
				guest: id,
			};
			const timer = this.later(
				() =>
					this.finishTrust(
						challenge.nonce,
						"Could not verify this device. Please try again.",
					),
				10000,
			);
			this.trustChallenges.set(challenge.nonce, {
				target: id,
				fingerprint: member.fingerprint,
				challenge,
				timer,
			});
			this.update({ verifyingTrust: [...this.state.verifyingTrust, id] });
			this.send(connection, { type: "identity-request", challenge });
			return;
		}
		if (this.state.role !== "host") return;
		const connection = this.channels.get(id);
		const fingerprint = connection && this.verified.get(connection);
		if (!member || !fingerprint) return;
		this.rememberPerson(fingerprint, member.profile.username);
	}
	forgetPerson(fingerprint: string) {
		for (const [nonce, pending] of this.trustChallenges)
			if (pending.fingerprint === fingerprint) this.finishTrust(nonce);
		const people = this.state.trustedPeople.filter(
			(p) => p.fingerprint !== fingerprint,
		);
		this.settings.write({ policy: this.state.joinPolicy, people });
		this.approvedKeys.delete(fingerprint);
		this.update({ trustedPeople: people });
	}
	private finishTrust(nonce: string, error?: string) {
		const pending = this.trustChallenges.get(nonce);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.timers.delete(pending.timer);
		this.trustChallenges.delete(nonce);
		this.update({
			verifyingTrust: this.state.verifyingTrust.filter(
				(id) => id !== pending.target,
			),
			...(error ? { notice: { id: crypto.randomUUID(), message: error } } : {}),
		});
	}
	private async answerTrustChallenge(
		connection: DataConnection,
		challenge: JoinChallenge,
	) {
		const identity = this.identity;
		const profile = this.profile;
		const generation = this.generation;
		if (
			!identity ||
			!profile ||
			challenge.guest !== this.peer?.id ||
			challenge.session !== this.session
		)
			return;
		const signature = await identity.sign(
			challenge,
			this.token,
			profile,
			"trust",
		);
		if (generation === this.generation && connection.open)
			this.send(connection, {
				type: "identity-proof",
				challenge,
				publicKey: identity.publicKey,
				profile,
				signature,
			});
	}
	private async verifyTrust(
		message: Extract<RoomMessage, { type: "identity-proof" }>,
	) {
		const pending = this.trustChallenges.get(message.challenge.nonce);
		if (
			!pending ||
			message.challenge.session !== pending.challenge.session ||
			message.challenge.host !== pending.challenge.host ||
			message.challenge.guest !== pending.challenge.guest
		)
			return;
		const fingerprint = await verifyIdentity(
			message.publicKey,
			pending.challenge,
			this.token,
			message.profile,
			message.signature,
			"trust",
		);
		if (this.trustChallenges.get(message.challenge.nonce) !== pending) return;
		const member = this.state.members.find((m) => m.id === pending.target);
		if (
			!fingerprint ||
			fingerprint !== pending.fingerprint ||
			member?.fingerprint !== fingerprint
		) {
			this.finishTrust(
				message.challenge.nonce,
				"The device identity could not be verified.",
			);
			return;
		}
		try {
			this.rememberPerson(fingerprint, message.profile.username);
			this.finishTrust(message.challenge.nonce);
		} catch (error) {
			this.finishTrust(
				message.challenge.nonce,
				error instanceof Error
					? error.message
					: "Could not save this trusted device.",
			);
		}
	}
	private welcome(connection: DataConnection, profile: RoomProfile) {
		if (
			this.state.members.length >= 8 &&
			!this.state.members.some((m) => m.id === connection.peer)
		) {
			connection.close();
			return;
		}
		const others = this.state.members.filter((m) => m.id !== connection.peer);
		this.update({
			members: [
				...others,
				{
					id: connection.peer,
					profile,
					status: "paused",
					fingerprint: this.verified.get(connection),
				},
			],
		});
		this.send(connection, {
			type: "welcome",
			session: this.session,
			members: this.state.members,
			permissions: this.state.permissions,
		});
		if (this.state.playback)
			this.send(connection, {
				type: "state",
				session: this.session,
				playback: this.state.playback,
			});
		this.publishMembers();
	}
	private fromHost(connection: DataConnection, message: RoomMessage) {
		if (message.type === "challenge") {
			if (
				!this.identity ||
				message.host !== connection.peer ||
				message.guest !== this.peer?.id
			) {
				connection.close();
				return;
			}
			const profile = this.sentProfiles.get(connection);
			if (!profile) return;
			const generation = this.generation;
			void this.identity
				.sign(message, this.token, profile)
				.then((signature) => {
					if (
						generation === this.generation &&
						this.channels.get(connection.peer) === connection &&
						this.sentProfiles.get(connection) === profile
					)
						this.send(connection, {
							type: "proof",
							nonce: message.nonce,
							signature,
						});
				})
				.catch(() => connection.close());
			return;
		}
		if (message.type === "end") {
			this.fail(message.reason);
			return;
		}
		if (message.type === "welcome") {
			if (this.session !== message.session) {
				this.revision = -1;
				this.update({ playback: null });
			}
			this.session = message.session;
			this.retry = 0;
			this.bestRtt = Infinity;
			this.pings.clear();
			this.update({
				status: "connected",
				members: message.members,
				permissions: message.permissions,
				error: null,
				clockOffset: null,
			});
			this.ping(connection);
			return;
		}
		if (
			this.state.status !== "connected" &&
			this.state.status !== "reconnecting"
		)
			return;
		if (message.type === "members") this.update({ members: message.members });
		if (
			message.type === "identity-request" &&
			message.challenge.session === this.session &&
			this.state.members.some((m) => m.id === message.challenge.host)
		) {
			void this.answerTrustChallenge(connection, message.challenge).catch(
				() => undefined,
			);
		}
		if (message.type === "identity-proof")
			void this.verifyTrust(message).catch(() =>
				this.finishTrust(
					message.challenge.nonce,
					"Could not verify this device.",
				),
			);
		if (message.type === "permissions")
			this.update({ permissions: message.permissions });
		if (message.type === "action-result")
			this.update({
				notice: {
					id: `${message.id}:${crypto.randomUUID()}`,
					message: message.message,
				},
			});
		if (
			message.type === "state" &&
			message.session === this.session &&
			message.playback.revision > this.revision
		) {
			this.revision = message.playback.revision;
			this.update({ playback: message.playback, status: "connected" });
		}
		if (
			message.type === "tick" &&
			message.session === this.session &&
			message.revision > this.revision &&
			message.instance === this.state.playback?.instance
		) {
			this.revision = message.revision;
			this.update({
				playback: { ...this.state.playback, ...message },
				status: "connected",
			});
		}
		if (message.type === "pong") {
			const sent = this.pings.get(message.id);
			this.pings.delete(message.id);
			if (sent === undefined || sent !== message.at) return;
			const rtt = now() - sent;
			if (rtt < this.bestRtt) {
				this.bestRtt = rtt;
				this.update({ clockOffset: message.hostAt - (sent + rtt / 2) });
			}
		}
	}
	private ping(connection: DataConnection) {
		const id = ++this.pingId;
		const at = now();
		this.pings.set(id, at);
		if (this.pings.size > 20)
			this.pings.delete(this.pings.keys().next().value as number);
		this.send(connection, { type: "ping", id, at });
	}
	private tick() {
		if (this.state.role !== "guest") return;
		const connection = this.channels.get(this.hostId);
		if (connection?.open && this.state.status === "connected") {
			this.ping(connection);
			if (now() - this.lastHeard > 10000) {
				this.update({ status: "reconnecting" });
				connection.close();
			}
		}
	}
	private reconnect() {
		if (this.state.role !== "guest" || this.state.status === "error") return;
		if (++this.retry > 5) {
			this.fail(
				"The host is no longer available. Rejoin when the room is back online.",
			);
			return;
		}
		this.update({ status: "reconnecting" });
		this.later(
			() => this.connectHost(),
			Math.min(1000 * 2 ** (this.retry - 1), 8000),
		);
	}

	broadcastPlayback(playback: Omit<RoomPlayback, "revision" | "sentAt">) {
		if (this.state.role !== "host" || this.state.status !== "hosting") return;
		const state: RoomPlayback = {
			...playback,
			revision: ++this.revision,
			sentAt: now(),
		};
		const structure = JSON.stringify([
			state.instance,
			state.queue,
			state.autoplayQueue,
			state.autoplayEnabled,
			state.index,
			state.song,
			state.repeatMode,
		]);
		const changed = structure !== this.structure;
		this.structure = structure;
		this.state = { ...this.state, playback: state };
		this.broadcast(
			changed
				? { type: "state", session: this.session, playback: state }
				: {
						type: "tick",
						session: this.session,
						revision: state.revision,
						instance: state.instance,
						position: state.position,
						playing: state.playing,
						sentAt: state.sentAt,
					},
		);
	}
	setStatus(status: Participant["status"]) {
		if (this.state.role === "guest" && this.state.status !== "connected")
			return;
		if (this.state.role === "host" && this.state.status !== "hosting") return;
		if (status === this.localStatus) return;
		this.localStatus = status;
		if (this.state.role === "guest") {
			const conn = this.channels.get(this.hostId);
			if (conn) this.send(conn, { type: "status", status });
		} else if (this.peer) {
			this.update({
				members: this.state.members.map((m) =>
					m.id === this.peer?.id ? { ...m, status } : m,
				),
			});
			this.publishMembers();
		}
	}
	setProfile(profile: RoomProfile) {
		if (!validProfile(profile)) throw new Error("Invalid room profile.");
		this.profile = profile;
		if (this.state.role === "host" && this.peer) {
			this.update({
				members: this.state.members.map((m) =>
					m.id === this.peer?.id ? { ...m, profile } : m,
				),
			});
			this.publishMembers();
		} else if (this.state.role === "guest") {
			const conn = this.channels.get(this.hostId);
			if (conn) {
				if (this.state.status === "connected")
					this.send(conn, { type: "profile", profile });
				else this.sayHello(conn);
			}
		}
	}
	suggestSongs(songs: Song[]) {
		return this.requestAction({ type: "add", songs });
	}
	private actionContext(): ActionContext {
		return {
			instance: this.state.playback?.instance ?? null,
			queueKey: queueKey(this.state.playback?.queue ?? []),
		};
	}
	setActionHandler(
		handler: (
			action: RoomAction,
			context: ActionContext,
		) => Promise<void> | void,
	) {
		this.actionHandler = handler;
		return () => {
			if (this.actionHandler === handler) this.actionHandler = null;
		};
	}
	setGuestPermissions(permissions: GuestPermissions) {
		if (this.state.role === "guest" || !validPermissions(permissions)) return;
		this.permissionStorage.write(permissions);
		for (const request of this.state.requests) {
			if (permissions[actionCategory(request.action)] !== "deny") continue;
			const connection = this.channels.get(request.from);
			if (connection)
				this.send(connection, {
					type: "action-result",
					id: request.id,
					message: "The host disabled this action.",
				});
		}
		this.update({
			permissions: { ...permissions },
			requests: this.state.requests.filter(
				(r) => permissions[actionCategory(r.action)] !== "deny",
			),
		});
		this.broadcast({
			type: "permissions",
			permissions: this.state.permissions,
		});
	}
	requestAction(input: RoomAction): "sent" | "denied" | "disconnected" {
		if (this.state.role !== "guest" || this.state.status !== "connected")
			return "disconnected";
		const action = parseRoomAction(input);
		if (!action || this.state.permissions[actionCategory(action)] === "deny")
			return "denied";
		const connection = this.channels.get(this.hostId);
		if (!connection?.open) return "disconnected";
		this.send(connection, {
			type: "action",
			id: crypto.randomUUID(),
			action,
			context: this.actionContext(),
		});
		return "sent";
	}
	private receiveAction(
		connection: DataConnection,
		id: string,
		action: RoomAction,
		context: ActionContext,
	) {
		const seen = this.seenActions.get(connection) ?? new Set<string>();
		if (seen.has(id)) return;
		if (seen.size >= 1000) {
			connection.close();
			return;
		}
		seen.add(id);
		this.seenActions.set(connection, seen);
		const mode = this.state.permissions[actionCategory(action)];
		if (mode === "deny") {
			this.send(connection, {
				type: "action-result",
				id,
				message: "The host does not allow this action.",
			});
			return;
		}
		const member = this.state.members.find((m) => m.id === connection.peer);
		if (!member) return;
		const current = this.actionContext();
		const category = actionCategory(action);
		if (
			(["skip", "remove", "reorder", "seek", "playback"].includes(category) &&
				context.instance !== current.instance) ||
			(["remove", "reorder"].includes(category) &&
				context.queueKey !== current.queueKey)
		) {
			this.send(connection, {
				type: "action-result",
				id,
				message: "The track or queue changed. Please try again.",
			});
			return;
		}
		const request: RoomRequest = {
			id,
			song:
				actionSong(action) ??
				(action.type === "autoplay" ? this.state.playback?.autoplayQueue[action.index] : null) ??
				(action.type === "remove"
					? (this.state.playback?.queue[action.index] ?? null)
					: null),
			action,
			context,
			profile: member.profile,
			from: connection.peer,
		};
		if (mode === "allow") {
			this.queueAction(request, false);
			return;
		}
		if (this.state.requests.length >= 20) {
			this.send(connection, {
				type: "action-result",
				id,
				message: "The host already has too many pending requests.",
			});
			return;
		}
		this.update({ requests: [...this.state.requests, request] });
	}
	resolveRequest(id: string, accept: boolean) {
		if (this.state.role !== "host") return;
		const request = this.state.requests.find((r) => r.id === id);
		if (!request) return;
		this.update({ requests: this.state.requests.filter((r) => r.id !== id) });
		if (accept) this.queueAction(request, true);
		else {
			const connection = this.channels.get(request.from);
			if (connection)
				this.send(connection, {
					type: "action-result",
					id,
					message: "The host declined your request.",
				});
		}
	}
	private queueAction(request: RoomRequest, approved: boolean) {
		const generation = this.generation;
		this.actionChain = this.actionChain
			.then(async () => {
				if (generation !== this.generation || this.state.role !== "host")
					return;
				const connection = this.channels.get(request.from);
				if (!connection || !this.isAdmitted(connection)) return;
				try {
					const category = actionCategory(request.action);
					const mode = this.state.permissions[category];
					if (mode === "deny" || (!approved && mode !== "allow"))
						throw new Error(
							"The host changed the permissions for this action.",
						);
					const context = this.actionContext();
					if (
						["skip", "remove", "reorder", "seek", "playback"].includes(
							category,
						) &&
						request.context.instance !== context.instance
					)
						throw new Error("The track changed. Please try again.");
					if (
						["remove", "reorder"].includes(category) &&
						request.context.queueKey !== context.queueKey
					)
						throw new Error("The queue changed. Please try again.");
					if (!this.actionHandler)
						throw new Error("The host player is not ready yet.");
					await this.actionHandler(attributeAction(request.action, request.profile.username), request.context);
				} catch (error) {
					if (approved)
						this.update({
							notice: {
								id: crypto.randomUUID(),
								message:
									error instanceof Error
										? error.message.slice(0, 300)
										: "The request could not be applied.",
							},
						});
					this.send(connection, {
						type: "action-result",
						id: request.id,
						message:
							error instanceof Error
								? error.message.slice(0, 300)
								: "The request could not be applied.",
					});
				}
			})
			.catch(() => undefined);
	}

	private fail(error: string) {
		this.leave();
		this.update({ status: "error", error });
	}
	leave() {
		const wasHost = this.state.role === "host";
		if (wasHost)
			this.broadcast({ type: "end", reason: "The host ended the room." });
		this.generation++;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
		const peer = this.peer;
		this.peer = null;
		this.channels.clear();
		this.admitted.clear();
		this.approvedKeys.clear();
		this.verified.clear();
		this.challenges.clear();
		this.sentProfiles.clear();
		this.trustChallenges.clear();
		this.seenActions.clear();
		this.actionChain = Promise.resolve();
		this.pings.clear();
		// Flush the end message before tearing down the data channels.
		if (wasHost && peer) setTimeout(() => peer.destroy(), 100);
		else peer?.destroy();
		this.revision = 0;
		this.structure = "";
		this.retry = 0;
		this.bestRtt = Infinity;
		this.localStatus = "paused";
		this.update({
			...initial(),
			permissions:
				this.state.role === "host"
					? this.state.permissions
					: this.permissionStorage.read(),
			joinPolicy: this.state.joinPolicy,
			trustedPeople: this.state.trustedPeople,
		});
	}
}

export const listenRoom = new ListenRoom();
export const useListenRoom = () =>
	useSyncExternalStore(listenRoom.subscribe, listenRoom.getSnapshot);
export const useRoomRole = () =>
	useSyncExternalStore(
		listenRoom.subscribe,
		() => listenRoom.getSnapshot().role,
	);

export const useRoomRepeat = () =>
	useSyncExternalStore(listenRoom.subscribe, () =>
		listenRoom.getSnapshot().role === "guest"
			? (listenRoom.getSnapshot().playback?.repeatMode ?? null)
			: null,
	);

export const useRoomAutoplay = () =>
	useSyncExternalStore(listenRoom.subscribe, () =>
		listenRoom.getSnapshot().playback?.autoplayEnabled ?? false,
	);
