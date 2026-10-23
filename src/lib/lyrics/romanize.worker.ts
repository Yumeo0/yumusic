import { createRomanizer } from "lyric-romanizer";

const romanizer = createRomanizer();

self.onmessage = async (
	event: MessageEvent<{ id: number; lines: string[] }>,
) => {
	const { id, lines } = event.data;
	try {
		const result = await romanizer.romanizeLines(lines);
		self.postMessage({ id, lines: result.lines });
	} catch {
		self.postMessage({ id, lines: [] });
	}
};
