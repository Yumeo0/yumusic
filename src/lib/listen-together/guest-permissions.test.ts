import { describe, expect, test } from "bun:test";
import {
	defaultPermissions,
	type GuestPermissions,
	permissionsStorage,
} from "./guest-permissions";

function withStorage(raw: string | null, run: () => void) {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => raw },
	});
	try {
		run();
	} finally {
		if (previous) Object.defineProperty(globalThis, "localStorage", previous);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
}

describe("saved guest permissions", () => {
	test("new rooms default to shared controls", () => {
		withStorage(null, () => {
			expect(Object.values(permissionsStorage.read())).toEqual(
				Array(8).fill("allow"),
			);
		});
	});
	test("explicit permissions survive the new default", () => {
		const saved: GuestPermissions = {
			...defaultPermissions,
			seek: "deny",
			add: "suggest",
		};
		withStorage(JSON.stringify(saved), () =>
			expect(permissionsStorage.read()).toEqual(saved),
		);
	});
	test("damaged saved settings do not silently grant shared controls", () => {
		for (const raw of ["not json", "null", JSON.stringify({ add: "allow" })]) {
			withStorage(raw, () =>
				expect(Object.values(permissionsStorage.read())).toEqual(
					Array(8).fill("deny"),
				),
			);
		}
	});
});
