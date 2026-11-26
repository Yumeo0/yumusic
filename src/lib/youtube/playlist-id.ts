/** YouTube browse ids add VL to the id used by sharing and editing. */
export function canonicalPlaylistId(id: string): string {
	return id.startsWith("VL") ? id.slice(2) : id;
}

export function playlistBrowseId(id: string): string {
	return `VL${canonicalPlaylistId(id)}`;
}
