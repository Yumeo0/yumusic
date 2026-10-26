import { describe, expect, test } from "bun:test";
import { addMetainfoRelease } from "./metainfo";

const xml = `<component>
  <releases>
    <release version="0.5.1" date="2026-10-24">
      <description><p>Existing release notes</p></description>
    </release>
  </releases>
</component>`;

describe("release metadata", () => {
	test("prepends a release while preserving earlier notes", () => {
		const updated = addMetainfoRelease(xml, "0.5.2", "2026-10-26");
		expect(updated).toContain('<release version="0.5.2" date="2026-10-26">');
		expect(updated).toContain("/releases/tag/v0.5.2</url>");
		expect(updated).toContain("Existing release notes");
		expect(updated.indexOf('version="0.5.2"')).toBeLessThan(
			updated.indexOf('version="0.5.1"'),
		);
	});

	test("keeps an already documented release intact", () => {
		expect(addMetainfoRelease(xml, "0.5.1", "2026-10-26")).toBe(xml);
	});

	test("rejects malformed release data and missing release history", () => {
		expect(() => addMetainfoRelease(xml, '0.5.2"', "2026-10-26")).toThrow();
		expect(() => addMetainfoRelease(xml, "0.5.2", "2026-02-30")).toThrow();
		expect(() =>
			addMetainfoRelease("<component/>", "0.5.2", "2026-10-26"),
		).toThrow();
	});
});
