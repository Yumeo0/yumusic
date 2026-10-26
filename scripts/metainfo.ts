/** Adds release metadata before a version is tagged. Existing notes stay intact. */
export function addMetainfoRelease(
	xml: string,
	version: string,
	date: string,
): string {
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`Invalid release version: ${version}`);
	}
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		new Date(date).toISOString().slice(0, 10) !== date
	) {
		throw new Error(`Invalid release date: ${date}`);
	}
	if (!xml.includes("<releases>")) {
		throw new Error("MetaInfo has no releases element");
	}
	if (xml.includes(`<release version="${version}"`)) return xml;
	return xml.replace(
		"<releases>",
		`<releases>
    <release version="${version}" date="${date}">
      <url type="details">https://git.yumeo.dev/Yumeo/YuMusic/releases/tag/v${version}</url>
    </release>`,
	);
}
