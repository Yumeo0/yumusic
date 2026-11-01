import type { DataConnection, Peer } from "peerjs";
import type { RoomPlayback } from "../listen-together/protocol";
import type { Tables } from "../sync/database.types";
import {
	type DeviceCommand,
	type DeviceRequest,
	type DeviceStatus,
	parseDeviceRequest,
} from "./protocol";

export type PlaybackDevice = Tables<"playback_devices">;
export interface DeviceAdapter {
	status(): DeviceStatus;
	playback(): RoomPlayback | null;
	available(): boolean;
	prepare(playback: RoomPlayback, valid: () => boolean): Promise<void>;
	start(playback: RoomPlayback, valid: () => boolean): Promise<void>;
	pause(): void;
	cancelTransfer(): void;
	control(command: DeviceCommand): void;
}
export interface DeviceRepository {
	publish(
		peer: string,
		token: string,
		state: DeviceStatus,
	): Promise<PlaybackDevice[]>;
	remove(token: string): Promise<void>;
}
export interface DeviceState {
	id: string;
	devices: PlaybackDevice[];
	status: "offline" | "connecting" | "online" | "error";
	error: string | null;
	busy: boolean;
}

/** Account-private discovery; capabilities are sent only inside encrypted WebRTC. */
export class DeviceHub {
	private state: DeviceState;
	private listeners = new Set<() => void>();
	private peer: Peer | null = null;
	private token = crypto.randomUUID();
	private stopped = false;
	private publishing = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private connections = new Set<DataConnection>();
	private incoming: DataConnection | null = null;
	constructor(
		id: string,
		private repository: DeviceRepository,
		private adapter: DeviceAdapter,
		private createPeer: () => Promise<Peer>,
	) {
		this.state = {
			id,
			devices: [],
			status: "connecting",
			error: null,
			busy: false,
		};
	}
	getSnapshot = () => this.state;
	subscribe = (fn: () => void) => {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	};
	private update(patch: Partial<DeviceState>) {
		if (this.stopped) return;
		this.state = { ...this.state, ...patch };
		for (const fn of this.listeners) fn();
	}
	async start() {
		try {
			const peer = await this.createPeer();
			if (this.stopped) {
				peer.destroy();
				return;
			}
			this.peer = peer;
			peer.on("connection", (c) => this.receive(c));
			peer.on("open", () => {
				void this.refresh();
			});
			// A peer factory can finish after signaling has already opened.
			if (peer.open) void this.refresh();
			peer.on("disconnected", () => {
				this.update({ status: "connecting" });
				if (!peer.destroyed) peer.reconnect();
			});
			peer.on("error", () =>
				this.update({
					status: "error",
					error:
						"Device connection failed. Check your connection and try again.",
				}),
			);
			this.timer = setInterval(() => {
				void this.refresh();
			}, 10_000);
		} catch {
			this.update({
				status: "error",
				error: "Could not start device connections.",
			});
		}
	}
	async refresh() {
		if (
			this.stopped ||
			this.publishing ||
			!this.peer?.id ||
			this.peer.disconnected
		)
			return;
		this.publishing = true;
		try {
			const devices = await this.repository.publish(
				this.peer.id,
				this.token,
				this.adapter.status(),
			);
			this.update({ devices, status: "online", error: null });
		} catch {
			this.update({
				devices: [],
				status: "error",
				error: "Could not discover your devices. Check sync and try again.",
			});
		} finally {
			this.publishing = false;
			if (this.stopped)
				void this.repository.remove(this.token).catch(() => undefined);
		}
	}
	private receive(c: DataConnection) {
		if (this.stopped || this.connections.size >= 12) {
			c.close();
			return;
		}
		this.connections.add(c);
		let handled = false;
		let confirmed = false;
		let prepared = false;
		const valid = () => !this.stopped && c.open && this.adapter.available();
		const deadline = setTimeout(() => c.close(), 30_000);
		c.on("error", () => c.close());
		c.on("close", () => {
			clearTimeout(deadline);
			this.connections.delete(c);
			if (this.incoming === c) {
				this.incoming = null;
				if (prepared && !confirmed) this.adapter.cancelTransfer();
			}
		});
		c.on("data", (raw: unknown) => {
			if (!raw || typeof raw !== "object") {
				c.close();
				return;
			}
			const m = raw as Record<string, unknown>;
			if (m.token !== this.token || m.version !== 1 || !valid()) {
				c.close();
				return;
			}
			if (m.type === "confirm" && prepared) {
				confirmed = true;
				c.send({ type: "confirmed" });
				return;
			}
			if (handled) return;
			handled = true;
			const request = parseDeviceRequest(m.request);
			if (!request) {
				c.send({
					type: "error",
					message:
						"This playback queue is incompatible. Reload both apps and try again.",
				});
				return;
			}
			void (async () => {
				try {
					if (request.type === "control") this.adapter.control(request.command);
					else if (request.type === "handoff") {
						if (request.target === this.state.id)
							throw new Error("Choose another device.");
						await this.transfer(request.target);
					} else {
						if (this.incoming || this.state.busy)
							throw new Error("This device is already transferring playback.");
						this.incoming = c;
						prepared = true;
						const playback = { ...request.playback, sentAt: Date.now() };
						await this.adapter.prepare(playback, valid);
						if (!valid()) throw new Error("Transfer cancelled.");
						await this.adapter.start(playback, valid);
						if (!valid()) {
							this.adapter.cancelTransfer();
							return;
						}
					}
					if (c.open) c.send({ type: "ok" });
					void this.refresh();
				} catch (e) {
					if (this.incoming === c && prepared) this.adapter.cancelTransfer();
					if (c.open)
						c.send({
							type: "error",
							message:
								e instanceof Error
									? e.message.slice(0, 200)
									: "Playback failed.",
						});
				}
			})();
		});
	}
	private call(
		device: PlaybackDevice,
		request: DeviceRequest,
		accepted?: () => void,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.peer || this.stopped) {
				reject(new Error("Devices are offline."));
				return;
			}
			const c = this.peer.connect(device.peer_id, { reliable: true });
			this.connections.add(c);
			let done = false;
			const finish = (error?: Error) => {
				if (done) return;
				done = true;
				clearTimeout(timeout);
				this.connections.delete(c);
				if (error) reject(error);
				else resolve();
				c.close();
			};
			const timeout = setTimeout(
				() =>
					finish(
						new Error(
							"Transfer timed out. Check the device connection and try again.",
						),
					),
				25_000,
			);
			c.on("open", () =>
				// The protocol uses JSON's optional-field semantics. BinaryPack
				// otherwise converts undefined song fields (e.g. duration) to null,
				// making a valid queue fail validation on the destination.
				c.send(
					JSON.parse(
						JSON.stringify({
							version: 1,
							token: device.connection_token,
							request,
						}),
					),
				),
			);
			c.on("error", () => finish(new Error("Could not reach that device.")));
			c.on("close", () =>
				finish(new Error("Device disconnected during transfer.")),
			);
			c.on("data", (raw: unknown) => {
				if (this.stopped || !raw || typeof raw !== "object") return;
				const m = raw as Record<string, unknown>;
				if (m.type === "error")
					finish(
						new Error(
							typeof m.message === "string"
								? m.message.slice(0, 200)
								: "Playback failed.",
						),
					);
				if (m.type === "ok") {
					try {
						accepted?.();
					} catch (e) {
						finish(e instanceof Error ? e : new Error("Transfer cancelled."));
						return;
					}
					if (request.type === "transfer")
						c.send({
							version: 1,
							token: device.connection_token,
							type: "confirm",
						});
					else finish();
				}
				if (m.type === "confirmed") finish();
			});
		});
	}
	private destination(id: string) {
		const device = this.state.devices.find(
			(d) => d.id === id && d.id !== this.state.id,
		);
		if (!device) throw new Error("That device is no longer available.");
		return device;
	}
	async control(id: string, command: DeviceCommand) {
		if (id === this.state.id) {
			this.adapter.control(command);
			return;
		}
		await this.call(this.destination(id), { type: "control", command });
		await this.refresh();
	}
	async transfer(target: string) {
		if (this.state.busy || this.incoming || !this.adapter.available())
			throw new Error("Leave Listen together before transferring playback.");
		const playback = this.adapter.playback();
		if (!playback?.song) throw new Error("Choose a song first.");
		const device = this.destination(target);
		this.update({ busy: true });
		try {
			await this.call(device, { type: "transfer", playback }, () => {
				if (
					!this.adapter.available() ||
					this.adapter.playback()?.instance !== playback.instance ||
					this.adapter.playback()?.playing !== playback.playing
				)
					throw new Error("The source track changed. Try transferring again.");
				this.adapter.pause();
			});
		} finally {
			this.update({ busy: false });
			void this.refresh();
		}
	}
	async move(source: string, target: string) {
		if (source === target) return;
		if (source === this.state.id) return this.transfer(target);
		await this.call(this.destination(source), { type: "handoff", target });
		await this.refresh();
	}
	stop() {
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		for (const c of this.connections) c.close();
		this.connections.clear();
		this.peer?.destroy();
		// Account-bound repository prevents a late cleanup affecting another user.
		void this.repository.remove(this.token).catch(() => undefined);
	}
}
