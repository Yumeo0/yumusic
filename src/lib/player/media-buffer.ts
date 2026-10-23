/** Keep roughly a minute of compressed audio, including a short rewind window. */
export const AUDIO_BUFFER_AHEAD = 45;
export const AUDIO_BUFFER_BEHIND = 30;

export function containsTime(ranges: TimeRanges, time: number): boolean {
	for (let i = 0; i < ranges.length; i++) {
		if (time >= ranges.start(i) && time < ranges.end(i)) return true;
	}
	return false;
}

export function bufferedAhead(ranges: TimeRanges, time: number): number {
	for (let i = 0; i < ranges.length; i++) {
		if (time >= ranges.start(i) && time < ranges.end(i))
			return ranges.end(i) - time;
	}
	return 0;
}

function abortError() {
	return new DOMException("Playback stopped", "AbortError");
}

/** Every wait releases its event listeners when a deck is stopped or replaced. */
function waitForEvent(
	target: EventTarget,
	event: string,
	signal: AbortSignal,
	pollMs?: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(abortError());
		const cleanup = () => {
			target.removeEventListener(event, done);
			signal.removeEventListener("abort", aborted);
			clearTimeout(timer);
		};
		const done = () => {
			cleanup();
			resolve();
		};
		const aborted = () => {
			cleanup();
			reject(abortError());
		};
		const timer = pollMs === undefined ? undefined : setTimeout(done, pollMs);
		target.addEventListener(event, done, { once: true });
		signal.addEventListener("abort", aborted, { once: true });
	});
}

function updateBuffer(
	buffer: SourceBuffer,
	operation: () => void,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(abortError());
		const cleanup = () => {
			buffer.removeEventListener("updateend", done);
			buffer.removeEventListener("error", failed);
			buffer.removeEventListener("abort", aborted);
			signal.removeEventListener("abort", aborted);
		};
		const done = () => {
			cleanup();
			resolve();
		};
		const failed = () => {
			cleanup();
			reject(new Error("Audio buffer update failed"));
		};
		const aborted = () => {
			cleanup();
			reject(abortError());
		};
		buffer.addEventListener("updateend", done, { once: true });
		buffer.addEventListener("error", failed, { once: true });
		buffer.addEventListener("abort", aborted, { once: true });
		signal.addEventListener("abort", aborted, { once: true });
		try {
			operation();
		} catch (error) {
			cleanup();
			reject(error);
		}
	});
}

export interface AudioStreamSession {
	audio: ReadableStream<Uint8Array>;
	mime: string;
	dispose: () => void;
}

/**
 * Applies backpressure to SABR instead of downloading the entire song into MSE.
 * Seeking outside the retained window opens a fresh SABR stream at that time.
 */
export async function mountBufferedAudio(
	media: HTMLMediaElement,
	createSession: (startTimeMs: number) => AudioStreamSession,
	options: { signal: AbortSignal; duration: number; onReady: () => void },
): Promise<void> {
	const source = new MediaSource();
	const objectUrl = URL.createObjectURL(source);
	let session: AudioStreamSession | null = null;
	let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	let controller = new AbortController();
	let restartAt: number | null = null;
	let loadingAt: number | null = 0;
	let ready = false;
	const abort = () => {
		controller.abort();
		void reader?.cancel().catch(() => undefined);
		session?.dispose();
	};
	const seek = () => {
		if (loadingAt !== null && Math.abs(loadingAt - media.currentTime) < 0.5)
			return;
		if (!containsTime(media.buffered, media.currentTime)) {
			restartAt = media.currentTime;
			abort();
		}
	};
	options.signal.addEventListener("abort", abort);
	try {
		options.signal.throwIfAborted();
		session = createSession(0);
		media.src = objectUrl;
		await waitForEvent(source, "sourceopen", options.signal);
		const buffer = source.addSourceBuffer(session.mime);
		if (options.duration > 0) source.duration = options.duration;
		media.addEventListener("seeking", seek);
		while (!options.signal.aborted) {
			const signal = controller.signal;
			try {
				if (!session) throw new Error("Audio stream is missing");
				reader = session.audio.getReader();
				while (!signal.aborted) {
					while (
						bufferedAhead(media.buffered, media.currentTime) >
						AUDIO_BUFFER_AHEAD
					) {
						await waitForEvent(media, "timeupdate", signal, 500);
					}
					const { value, done } = await reader.read();
					if (done) break;
					if (!value?.byteLength) continue;
					await updateBuffer(
						buffer,
						() => buffer.appendBuffer(value as unknown as BufferSource),
						signal,
					);
					if (buffer.buffered.length > 0) loadingAt = null;
					if (!ready && buffer.buffered.length > 0) {
						ready = true;
						options.onReady();
					}
					const before = media.currentTime - AUDIO_BUFFER_BEHIND;
					if (
						before > 0 &&
						buffer.buffered.length > 0 &&
						buffer.buffered.start(0) < before - 5
					) {
						await updateBuffer(buffer, () => buffer.remove(0, before), signal);
					}
				}
				if (!signal.aborted && source.readyState === "open")
					source.endOfStream();
				// Release the producer at EOF; retain only the seek listener and MSE window.
				reader.releaseLock();
				reader = null;
				session?.dispose();
				session = null;
				while (restartAt === null) await waitForEvent(media, "seeking", signal);
			} catch (error) {
				if (!signal.aborted) throw error;
			}
			if (options.signal.aborted) break;
			if (restartAt === null) continue;
			const start = restartAt;
			restartAt = null;
			if (reader) {
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
				reader = null;
			}
			session?.dispose();
			if (buffer.updating) {
				// abort() queues events; let them drain before listening for the
				// next remove/append so an old abort cannot reject a new operation.
				const settled = waitForEvent(buffer, "updateend", options.signal);
				buffer.abort();
				await settled;
			}
			controller = new AbortController();
			loadingAt = start;
			await updateBuffer(
				buffer,
				() => buffer.remove(0, Infinity),
				options.signal,
			);
			session = createSession(Math.floor(start * 1000));
		}
	} finally {
		abort();
		await reader?.cancel().catch(() => undefined);
		reader?.releaseLock();
		media.removeEventListener("seeking", seek);
		options.signal.removeEventListener("abort", abort);
		if (media.src === objectUrl) {
			media.pause();
			media.removeAttribute("src");
			media.load();
		}
		URL.revokeObjectURL(objectUrl);
	}
}
