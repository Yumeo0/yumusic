import { describe, expect, test } from "bun:test";
import { formatBytes } from "./utils";

describe("formatBytes", () => {
	test("uses binary units", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(900)).toBe("900 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(5 * 1024 ** 2)).toBe("5.0 MB");
		expect(formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
	});
});
