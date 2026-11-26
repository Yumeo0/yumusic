import { expect, spyOn, test } from "bun:test";
import { youtubeFetch } from "./youtube-fetch";

test("a response releases the request timeout and keeps the upstream query intact", async () => {
	const request = spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("audio"),
	);
	const start = spyOn(globalThis, "setTimeout");
	const stop = spyOn(globalThis, "clearTimeout");
	try {
		const response = await youtubeFetch(
			"https://rr1.googlevideo.com/videoplayback?sig=a+b%2B~",
		);
		expect(await response.text()).toBe("audio");
		expect(request.mock.calls[0][0]).toContain(
			"?sig=a+b%2B~&__host=rr1.googlevideo.com",
		);
		expect(stop).toHaveBeenCalledWith(start.mock.results[0].value);
	} finally {
		stop.mockRestore();
		start.mockRestore();
		request.mockRestore();
	}
});
