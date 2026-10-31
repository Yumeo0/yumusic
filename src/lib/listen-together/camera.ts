/** Request permission before starting the decoder; Android may hide the page during its prompt. */
export async function acquireCamera(
	request: () => Promise<MediaStream>,
	waitForForeground: (signal: AbortSignal) => Promise<void>,
	signal: AbortSignal,
): Promise<MediaStream> {
	const stream = await request();
	const stop = () => {
		for (const track of stream.getTracks()) track.stop();
	};
	if (signal.aborted) {
		stop();
		throw new DOMException("Scanner closed", "AbortError");
	}
	signal.addEventListener("abort", stop, { once: true });
	try {
		await waitForForeground(signal);
		if (signal.aborted) throw new DOMException("Scanner closed", "AbortError");
		return stream;
	} catch (error) {
		stop();
		throw error;
	}
}

export function waitForCameraForeground(signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			document.removeEventListener("visibilitychange", check);
			window.removeEventListener("focus", check);
			signal.removeEventListener("abort", abort);
		};
		const abort = () => {
			cleanup();
			reject(new DOMException("Scanner closed", "AbortError"));
		};
		const check = () => {
			if (!document.hidden) {
				cleanup();
				resolve();
			}
		};
		document.addEventListener("visibilitychange", check);
		window.addEventListener("focus", check);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else check();
	});
}
