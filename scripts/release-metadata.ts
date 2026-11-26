export function releaseVersion(value: string): string {
	const version = value.replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(`Invalid release version: ${value}`);
	return version;
}

export function validateReleaseDate(date: string) {
	const time = Date.parse(date);
	if (
		!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
		!Number.isFinite(time) ||
		new Date(time).toISOString().slice(0, 10) !== date
	)
		throw new Error(`Invalid release date: ${date}`);
}
