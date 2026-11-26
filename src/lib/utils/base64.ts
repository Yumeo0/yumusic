export function bytesToBase64(bytes: Uint8Array): string {
	if (typeof bytes.toBase64 === "function") return bytes.toBase64();
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
