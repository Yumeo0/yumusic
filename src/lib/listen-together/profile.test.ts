import { describe, expect, test } from "bun:test";
import {
	prepareAvatar,
	profileSource,
	readRoomProfile,
	saveRoomProfile,
	validProfile,
} from "./profile";

describe("room profiles", () => {
	test("only reuses a confirmed profile for the same account source", () => {
		const previous = Object.getOwnPropertyDescriptor(
			globalThis,
			"localStorage",
		);
		const storage = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
			},
		});
		try {
			expect(readRoomProfile("google:a")).toBeNull();
			const profile = { username: "Chosen name", avatar: null };
			saveRoomProfile("google:a", profile);
			expect(readRoomProfile("google:a")).toEqual(profile);
			expect(readRoomProfile("google:b")).toBeNull();
			expect(readRoomProfile("guest")).toBeNull();
			expect(() =>
				saveRoomProfile("google:a", { username: "", avatar: null }),
			).toThrow();
		} finally {
			if (previous) Object.defineProperty(globalThis, "localStorage", previous);
			else Reflect.deleteProperty(globalThis, "localStorage");
		}
	});
	test("accepts chosen names and initials, but rejects unsafe or oversized images", () => {
		expect(validProfile({ username: "Yumeo", avatar: null })).toBe(true);
		expect(
			validProfile({
				username: "Yumeo",
				avatar: "data:image/jpeg;base64,YQ==",
			}),
		).toBe(true);
		for (const username of [
			"",
			" ",
			" Leading",
			"Line\nBreak",
			"a".repeat(41),
		]) {
			expect(validProfile({ username, avatar: null })).toBe(false);
		}
		for (const avatar of [
			"https://example.com/avatar",
			"data:image/svg+xml;base64,YQ==",
			`data:image/jpeg;base64,${"a".repeat(48000)}`,
		]) {
			expect(validProfile({ username: "Test", avatar })).toBe(false);
		}
	});

	test("account changes require a new confirmation without persisting account details", async () => {
		const a = await profileSource({
			name: "Alice",
			photo: "https://example.com/a",
		});
		expect(a).toBe(
			await profileSource({ name: "Alice", photo: "https://example.com/a" }),
		);
		expect(a).not.toBe(
			await profileSource({ name: "Bob", photo: "https://example.com/b" }),
		);
		expect(a).not.toContain("Alice");
		expect(await profileSource(null)).toBe("guest");
	});

	test("rejects unsupported or oversized uploads before decoding", async () => {
		await expect(
			prepareAvatar(new Blob(["svg"], { type: "image/svg+xml" })),
		).rejects.toThrow("Choose a PNG");
		await expect(
			prepareAvatar(
				new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" }),
			),
		).rejects.toThrow("smaller than 5 MB");
	});
});
