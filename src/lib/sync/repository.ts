import { accountDataClient } from "./client";
import type { SyncTransport } from "./engine";
import { type RemoteRecord, ZERO_EDIT_ID } from "./records";

const PAGE_SIZE = 500;

export function syncRepository(owner: string): SyncTransport {
	const client = accountDataClient(owner);
	const records = () =>
		client
			.from("sync_records")
			.select("key,value,revision,modified_at,edit_id")
			.eq("user_id", owner);
	return {
		async read() {
			const result: RemoteRecord[] = [];
			for (let offset = 0; ; offset += PAGE_SIZE) {
				const { data, error } = await records()
					.order("key")
					.range(offset, offset + PAGE_SIZE - 1);
				if (error) throw error;
				result.push(...data);
				if (data.length < PAGE_SIZE) return result;
			}
		},
		async write(key, pending) {
			const { data, error } = await client.rpc("write_sync_record", {
				record_key: key,
				record_value: pending.value,
				expected_revision: pending.revision,
				record_modified_at: pending.modified_at ?? 0,
				record_edit_id: pending.edit_id ?? ZERO_EDIT_ID,
			});
			if (error) throw error;
			if (data?.[0]) return data[0];
			const result = await records().eq("key", key).single();
			if (result.error) throw result.error;
			return result.data;
		},
	};
}
