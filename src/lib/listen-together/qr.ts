import { parseInvite } from "./protocol";

/** Encode the private room invitation locally; no external QR service is used. */
export async function createRoomQr(invite: string): Promise<string> {
	if (!parseInvite(invite)) throw new Error("Invalid room invitation");
	const { default: QRCode } = await import("qrcode");
	return QRCode.toDataURL(invite.trim(), {
		errorCorrectionLevel: "M",
		margin: 4,
		width: 320,
		color: { dark: "#000000", light: "#ffffff" },
	});
}
