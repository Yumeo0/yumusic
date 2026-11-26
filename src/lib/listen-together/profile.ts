import { validParticipantName } from "../player/shared-playback";
import { notifySyncChange } from "../sync/events";

export interface RoomProfile {
	username: string;
	avatar: string | null;
}

export const MAX_AVATAR_LENGTH = 48_000;
const KEY = "yumusic:room-profile:v1";

export function validProfile(value: unknown): value is RoomProfile {
	if (!value || typeof value !== "object") return false;
	const { username, avatar } = value as RoomProfile;
	return (
		validParticipantName(username) &&
		(avatar === null ||
			(typeof avatar === "string" &&
				avatar.length <= MAX_AVATAR_LENGTH &&
				/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar)))
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

interface SavedRoomProfile {
	source: string;
	profile: RoomProfile;
}

export function validSavedRoomProfile(
	value: unknown,
): value is SavedRoomProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const { source, profile } = value as Partial<SavedRoomProfile>;
	return (
		typeof source === "string" && source.length <= 200 && validProfile(profile)
	);
}

export function readSavedRoomProfile(): SavedRoomProfile | null {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(KEY) || "null");
		return validSavedRoomProfile(saved) ? saved : null;
	} catch {
		return null;
	}
}

export function replaceSavedRoomProfile(value: SavedRoomProfile | null) {
	if (value) localStorage.setItem(KEY, JSON.stringify(value));
	else localStorage.removeItem(KEY);
	notifySyncChange();
}

export function readRoomProfile(source: string): RoomProfile | null {
	const saved = readSavedRoomProfile();
	return saved?.source === source ? saved.profile : null;
}

export function saveRoomProfile(source: string, profile: RoomProfile) {
	if (!validProfile(profile))
		throw new Error("Enter a username of 1–40 characters and a valid picture.");
	try {
		replaceSavedRoomProfile({ source, profile });
	} catch {
		// Confirmation can still succeed for this session if storage is unavailable.
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
