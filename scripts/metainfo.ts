import { releaseVersion, validateReleaseDate } from "./release-metadata";

export function addMetainfoRelease(
	xml: string,
	version: string,
	date: string,
): string {
	if (releaseVersion(version) !== version) {
		throw new Error(`Invalid release version: ${version}`);
	}
	validateReleaseDate(date);
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
