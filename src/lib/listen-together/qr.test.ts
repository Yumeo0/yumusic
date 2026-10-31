import { expect, test } from "bun:test";
import { PNG } from "pngjs";
// @ts-expect-error The scanner's worker factory has no standalone declaration.
import { createWorker } from "qr-scanner/qr-scanner-worker.min.js";
import { parseInvite } from "./protocol";
import { createRoomQr } from "./qr";

test("room QR images round-trip through the scanner's real decoder", async () => {
	for (const host of ["room-host_123", "a".repeat(100)]) {
		const invite = `yu1.${host}.${"ab".repeat(16)}`;
		const url = await createRoomQr(invite);
		const png = PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
		const worker: Worker = createWorker();
		try {
			const decoded = await new Promise<string>((resolve, reject) => {
				worker.onmessage = (event) => resolve(event.data.data);
				worker.onerror = (event) => reject(new Error(event.message));
				worker.postMessage({
					id: 1,
					type: "decode",
					data: {
						data: new Uint8ClampedArray(png.data),
						width: png.width,
						height: png.height,
					},
				});
			});
			expect(decoded).toBe(invite);
			expect(parseInvite(decoded)).toEqual({ host, token: "ab".repeat(16) });
		} finally {
			worker.terminate();
		}
	}
});

test("QR generation rejects incomplete invitations and arbitrary URLs", async () => {
	for (const invalid of ["yu1.host.short", "https://example.com", ""]) {
		await expect(createRoomQr(invalid)).rejects.toThrow(
			"Invalid room invitation",
		);
	}
});
