import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

const port = 8080;

const ALLOWED_HEADERS = [
	"Origin",
	"X-Requested-With",
	"Content-Type",
	"Accept",
	"Authorization",
	"x-goog-visitor-id",
	"x-goog-api-key",
	"x-origin",
	"x-youtube-client-version",
	"x-youtube-client-name",
	"x-goog-api-format-version",
	"x-goog-authuser",
	"x-user-agent",
	"Accept-Language",
	"X-Goog-FieldMask",
	"Range",
	"Referer",
	"Cookie",
	"X-Proxy-Headers",
].join(", ");

function copyHeader(headerName: string, to: Headers, from: Headers) {
	const hdrVal = from.get(headerName);
	if (hdrVal) {
		to.set(headerName, hdrVal);
	}
}

// Helper to convert Node's IncomingMessage to a Web Standard Request
async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
	const protocol = req.headers["x-forwarded-proto"] || "http";
	const host = req.headers.host || "localhost";
	const url = new URL(req.url || "", `${protocol}://${host}`);

	return new Request(url.toString(), {
		method: req.method,
		headers: req.headers as HeadersInit,
		// Provide body for non-GET/HEAD requests
		body:
			req.method !== "GET" && req.method !== "HEAD"
				? (Readable.toWeb(req) as ReadableStream)
				: null,
		// @ts-expect-error: duplex is required for streaming bodies in Node fetch
		duplex: "half",
	});
}

export function startProxy() {
	const server = createServer({ maxHeaderSize: 65536 }, async (req, res) => {
		try {
			const request = await nodeToWebRequest(req);
			const origin = request.headers.get("origin") || "";

			// Handle CORS preflight
			if (request.method === "OPTIONS") {
				res.writeHead(200, {
					"Access-Control-Allow-Origin": origin,
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": ALLOWED_HEADERS,
					"Access-Control-Max-Age": "86400",
					"Access-Control-Allow-Credentials": "true",
				});
				res.end();
				return;
			}

			const url = new URL(request.url);
			if (!url.searchParams.has("__host")) {
				res.writeHead(400);
				res.end(
					"Request is formatted incorrectly. Please include __host in the query string.",
				);
				return;
			}

			// Proxy Logic
			url.host = url.searchParams.get("__host");
			url.protocol = "https:";
			url.port = "443";
			url.searchParams.delete("__host");

			let headersStr = url.searchParams.get("__headers");
			if (!headersStr) {
				headersStr = request.headers.get("x-proxy-headers");
			}

			if (!headersStr) {
				console.warn(
					"[Proxy] Warning: No headers found (neither __headers nor x-proxy-headers)",
				);
			}

			const request_headers = new Headers();
			if (headersStr) {
				try {
					const parsed = JSON.parse(headersStr);
					for (const [key, value] of Object.entries(parsed)) {
						request_headers.set(key, value as string);
					}
				} catch (e) {
					console.error("[Proxy] Error parsing headers JSON:", e);
				}
			}

			copyHeader("range", request_headers, request.headers);
			if (!request_headers.has("user-agent")) {
				copyHeader("user-agent", request_headers, request.headers);
			}

			url.searchParams.delete("__headers");

			if (url.host.includes("youtube")) {
				request_headers.set("origin", "https://www.youtube.com");
				request_headers.set("referer", "https://www.youtube.com/");
			}

			// Ensure we don't forward host header which might confuse the server
			request_headers.delete("host");

			if (request.headers.has("Authorization")) {
				request_headers.set(
					"Authorization",
					request.headers.get("Authorization"),
				);
			}

			const fetchRes = await fetch(url.toString(), {
				method: request.method,
				headers: request_headers,
				body: request.body,
				// @ts-expect-error
				duplex: "half",
			});

			// Construct return headers
			const responseHeaders: Record<string, string> = {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Headers": ALLOWED_HEADERS,
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Credentials": "true",
			};

			const copyToRes = (name: string) => {
				const val = fetchRes.headers.get(name);
				if (val) responseHeaders[name] = val;
			};

			[
				"content-type",
				"content-disposition",
				"accept-ranges",
				"content-range",
			].forEach(copyToRes);

			res.writeHead(fetchRes.status, responseHeaders);

			// Stream the body back to the client
			if (fetchRes.body) {
				const reader = fetchRes.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					res.write(value);
				}
			}
			res.end();
		} catch (err) {
			console.error(err);
			res.writeHead(500);
			res.end("Internal Server Error");
		}
	});

	server.listen(port, () => {
		console.log(`Proxy server running on http://localhost:${port}`);
	});
}
