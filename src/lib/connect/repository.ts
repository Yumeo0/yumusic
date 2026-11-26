import { accountDataClient } from "../sync/client";
import { localDeviceKind, readDeviceName } from "./device-name";
import type { DeviceRepository } from "./hub";
import { deviceStatus } from "./protocol";

export function deviceRepository(owner: string, id: string): DeviceRepository {
	const client = accountDataClient(owner);
	return {
		async publish(peerId, connectionToken, status) {
			const { data, error } = await client.rpc("publish_playback_device", {
				device_id: id,
				device_peer: peerId,
				device_token: connectionToken,
				device_name: readDeviceName(),
				device_kind: localDeviceKind(),
				device_state: { ...status },
			});
			if (error) throw error;
			return data.map((row) => ({
				id: row.id,
				name: row.name,
				kind: row.kind,
				peerId: row.peer_id,
				connectionToken: row.connection_token,
				status: deviceStatus(row.state),
			}));
		},
		async remove(token) {
			const { error } = await client
				.from("playback_devices")
				.delete()
				.eq("user_id", owner)
				.eq("id", id)
				.eq("connection_token", token);
			if (error) throw error;
		},
	};
}
