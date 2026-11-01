import { notifySyncChange } from "../sync/events";

export interface RoomProfile {
	username: string;
	avatar: string | null;
}

export const MAX_AVATAR_LENGTH = 48_000;
const KEY = "yumusic:room-profile:v1";

export function validProfile(value: unknown): value is RoomProfile {
	if (!value || typeof value !== "object") return false;
	const p = value as RoomProfile;
	return (
		typeof p.username === "string" &&
		p.username.trim() === p.username &&
		p.username.length > 0 &&
		p.username.length <= 40 &&
		!Array.from(p.username).some(
			(c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
		) &&
		(p.avatar === null ||
			(typeof p.avatar === "string" &&
				p.avatar.length <= MAX_AVATAR_LENGTH &&
				/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(p.avatar)))
	);
}

export async function profileSource(
	account: { name?: string; photo?: string; accountId?: string } | null,
) {
	if (!account) return "guest";
	const bytes = new TextEncoder().encode(
		account.accountId || `${account.name || ""}\n${account.photo || ""}`,
	);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return `google:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function readRoomProfile(source: string): RoomProfile | null {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) || "null");
		return saved?.source === source && validProfile(saved.profile)
			? saved.profile
			: null;
	} catch {
		return null;
	}
}

export function saveRoomProfile(source: string, profile: RoomProfile) {
	if (!validProfile(profile))
		throw new Error("Enter a username of 1–40 characters and a valid picture.");
	// Confirmation can still succeed for this session if storage is unavailable.
	try {
		localStorage.setItem(KEY, JSON.stringify({ source, profile }));
		notifySyncChange();
	} catch {
		/* best effort */
	}
}

/** Decode and re-encode pictures locally; remote URLs never go to participants. */
export async function prepareAvatar(file: Blob): Promise<string> {
	if (file.size > 5 * 1024 * 1024)
		throw new Error("Choose an image smaller than 5 MB.");
	if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type))
		throw new Error("Choose a PNG, JPEG, WebP or GIF image.");
	const url = URL.createObjectURL(file);
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 128;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Could not process this image.");
		const side = Math.min(image.naturalWidth, image.naturalHeight);
		context.drawImage(
			image,
			(image.naturalWidth - side) / 2,
			(image.naturalHeight - side) / 2,
			side,
			side,
			0,
			0,
			128,
			128,
		);
		const avatar = canvas.toDataURL("image/jpeg", 0.8);
		if (avatar.length > MAX_AVATAR_LENGTH)
			throw new Error("This picture is too large. Try another image.");
		return avatar;
	} finally {
		URL.revokeObjectURL(url);
	}
}
