/**
 * Fisher–Yates shuffle over the tail of `songs` starting at `start`,
 * leaving everything before it untouched. The queue passes the index after
 * the current song, so shuffling never disturbs the track that is playing
 * or the entries already behind it.
 *
 * Returns the input array as-is when the tail holds fewer than two entries,
 * which lets a state setter bail out without a re-render.
 */
export function shuffleFrom<T>(songs: T[], start: number): T[] {
	const first = Math.max(0, Math.min(start, songs.length));
	if (songs.length - first < 2) return songs;
	const shuffled = songs.slice();
	for (let i = shuffled.length - 1; i > first; i--) {
		const j = first + Math.floor(Math.random() * (i - first + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	return shuffled;
}
