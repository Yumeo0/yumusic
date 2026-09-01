use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

const ALLOWED_HEADERS: &str = "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-goog-visitor-id, x-goog-api-key, x-origin, x-youtube-client-version, x-youtube-client-name, x-goog-api-format-version, x-goog-authuser, x-user-agent, Accept-Language, X-Goog-FieldMask, Range, Referer, Cookie, X-Proxy-Headers";

/// In-memory cache for proxied images, bounded by total bytes with LRU
/// eviction. Needed because custom-scheme responses are not kept in the
/// WebView's HTTP cache, so every proxied image would otherwise be
/// re-fetched upstream on every display — the main source of 429s.
const IMAGE_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
const IMAGE_CACHE_MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const IMAGE_FRESHNESS_FALLBACK: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const IMAGE_FRESHNESS_CAP: u64 = 30 * 24 * 60 * 60;

#[derive(Clone)]
struct CachedImage {
	status: u16,
	headers: Vec<(String, String)>,
	body: Arc<Vec<u8>>,
	etag: Option<String>,
	fresh_until: Instant,
	last_used: Instant,
}

struct ImageCache {
	entries: HashMap<String, CachedImage>,
	total_bytes: usize,
}

impl ImageCache {
	fn insert(&mut self, key: String, entry: CachedImage) {
		self.total_bytes += entry.body.len();
		self.entries.insert(key, entry);
		while self.total_bytes > IMAGE_CACHE_MAX_BYTES {
			// Evict the least recently used entry.
			let victim = self
				.entries
				.iter()
				.min_by_key(|(_, entry)| entry.last_used)
				.map(|(key, _)| key.clone());
			let Some(victim) = victim else { break };
			if let Some(removed) = self.entries.remove(&victim) {
				self.total_bytes -= removed.body.len();
			}
		}
	}
}

fn image_cache() -> &'static Mutex<ImageCache> {
	static CACHE: OnceLock<Mutex<ImageCache>> = OnceLock::new();
	CACHE.get_or_init(|| {
		Mutex::new(ImageCache {
			entries: HashMap::new(),
			total_bytes: 0,
		})
	})
}

/// How long a cached image stays fresh: `max-age` from `cache-control` when
/// present (capped), otherwise a week — artwork for a video id never changes.
fn image_freshness(headers: &HeaderMap) -> Option<Duration> {
	let control = headers
		.get("cache-control")
		.and_then(|value| value.to_str().ok());
	if let Some(control) = control {
		if control.contains("no-store") || control.contains("no-cache") {
			return None;
		}
		let max_age = control
			.split(',')
			.map(str::trim)
			.find_map(|directive| directive.strip_prefix("max-age="))
			.and_then(|seconds| seconds.parse::<u64>().ok());
		if let Some(seconds) = max_age {
			return Some(Duration::from_secs(seconds.min(IMAGE_FRESHNESS_CAP)));
		}
	}
	Some(IMAGE_FRESHNESS_FALLBACK)
}

fn is_image_response(headers: &HeaderMap) -> bool {
	headers
		.get("content-type")
		.and_then(|value| value.to_str().ok())
		.is_some_and(|ctype| ctype.trim().to_ascii_lowercase().starts_with("image/"))
}

/// Returns a 200 (or conditional 304) response served from the in-memory
/// cache, or `None` when the entry is missing or stale.
fn cache_lookup(
	request: &Request<Vec<u8>>,
	target: &str,
	origin: &str,
) -> Option<Response<Vec<u8>>> {
	let now = Instant::now();
	let entry = {
		let mut cache = image_cache().lock().ok()?;
		let entry = cache.entries.get_mut(target)?;
		if now >= entry.fresh_until {
			return None;
		}
		entry.last_used = now;
		entry.clone()
	};

	let if_none_match = request
		.headers()
		.get("if-none-match")
		.and_then(|value| value.to_str().ok());
	if let (Some(inm), Some(etag)) = (if_none_match, entry.etag.as_deref()) {
		if inm == etag {
			let mut response = Response::new(Vec::new());
			*response.status_mut() = StatusCode::NOT_MODIFIED;
			apply_cors(&mut response, origin);
			if let Ok(value) = HeaderValue::from_str(etag) {
				response.headers_mut().insert("etag", value);
			}
			return Some(response);
		}
	}

	let mut response = Response::new((*entry.body).clone());
	if let Ok(status) = StatusCode::from_u16(entry.status) {
		*response.status_mut() = status;
	}
	apply_cors(&mut response, origin);
	let headers = response.headers_mut();
	for (name, value) in &entry.headers {
		if let (Ok(name), Ok(value)) = (
			HeaderName::from_bytes(name.as_bytes()),
			HeaderValue::from_str(value),
		) {
			headers.insert(name, value);
		}
	}
	Some(response)
}

fn client() -> &'static reqwest::Client {
	static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
	CLIENT.get_or_init(reqwest::Client::new)
}

pub fn handle<R: Runtime>(
	_ctx: UriSchemeContext<'_, R>,
	request: Request<Vec<u8>>,
	responder: UriSchemeResponder,
) {
	tauri::async_runtime::spawn(async move {
		let response = process(request).await.unwrap_or_else(internal_error);
		responder.respond(response);
	});
}

fn internal_error(message: String) -> Response<Vec<u8>> {
	Response::builder()
		.status(StatusCode::INTERNAL_SERVER_ERROR)
		.body(message.into_bytes())
		.unwrap_or_else(|_| Response::new(b"Internal Server Error".to_vec()))
}

fn apply_cors(response: &mut Response<Vec<u8>>, origin: &str) {
	let headers = response.headers_mut();
	if !origin.is_empty() {
		if let Ok(value) = HeaderValue::from_str(origin) {
			headers.insert("access-control-allow-origin", value);
		}
	}
	headers.insert(
		"access-control-allow-headers",
		HeaderValue::from_static(ALLOWED_HEADERS),
	);
	headers.insert(
		"access-control-allow-methods",
		HeaderValue::from_static("GET, POST, OPTIONS"),
	);
	headers.insert(
		"access-control-allow-credentials",
		HeaderValue::from_static("true"),
	);
	headers.insert(
		"access-control-max-age",
		HeaderValue::from_static("86400"),
	);
}

fn percent_decode(input: &str) -> String {
	let bytes = input.as_bytes();
	let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		match bytes[i] {
			b'+' => {
				out.push(b' ');
				i += 1;
			}
			b'%' if i + 2 < bytes.len() => {
				let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
				match u8::from_str_radix(hex, 16) {
					Ok(byte) => {
						out.push(byte);
						i += 3;
					}
					Err(_) => {
						out.push(b'%');
						i += 1;
					}
				}
			}
			byte => {
				out.push(byte);
				i += 1;
			}
		}
	}
	String::from_utf8_lossy(&out).into_owned()
}

async fn process(request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
	let origin = request
		.headers()
		.get("origin")
		.and_then(|value| value.to_str().ok())
		.unwrap_or_default()
		.to_owned();

	if request.method() == Method::OPTIONS {
		let mut response = Response::new(Vec::new());
		*response.status_mut() = StatusCode::OK;
		apply_cors(&mut response, &origin);
		return Ok(response);
	}

	let url = tauri::Url::parse(&request.uri().to_string()).map_err(|e| e.to_string())?;
	let raw_query = url.query().unwrap_or_default();

	let mut host: Option<String> = None;
	let mut headers_json: Option<String> = None;
	let mut kept: Vec<&str> = Vec::new();
	for pair in raw_query.split('&').filter(|pair| !pair.is_empty()) {
		let (key, value) = match pair.split_once('=') {
			Some((key, value)) => (key, Some(value)),
			None => (pair, None),
		};
		match key {
			"__host" => host = value.map(percent_decode),
			"__headers" => headers_json = value.map(percent_decode),
			_ => kept.push(pair),
		}
	}

	let host = host.ok_or("missing __host parameter")?;
	let mut target = format!("https://{}{}", host, url.path());
	if !kept.is_empty() {
		target.push('?');
		target.push_str(&kept.join("&"));
	}

	let method = request.method().clone();

	// Only plain GETs without range requests are eligible for the image cache.
	let cacheable_request = method == Method::GET && request.headers().get("range").is_none();
	if cacheable_request {
		if let Some(response) = cache_lookup(&request, &target, &origin) {
			return Ok(response);
		}
	}

	let mut upstream_headers = HeaderMap::new();
	let headers_source = headers_json.or_else(|| {
		request
			.headers()
			.get("x-proxy-headers")
			.and_then(|value| value.to_str().ok())
			.map(String::from)
	});
	if let Some(source) = headers_source {
		let parsed: Value = serde_json::from_str(&source).map_err(|e| e.to_string())?;
		if let Value::Object(map) = parsed {
			for (key, value) in map {
				let Some(value) = value.as_str() else { continue };
				if let (Ok(name), Ok(header_value)) = (
					HeaderName::from_bytes(key.as_bytes()),
					HeaderValue::from_str(value),
				) {
					upstream_headers.insert(name, header_value);
				}
			}
		}
	}

	if let Some(range) = request.headers().get("range") {
		upstream_headers.insert("range", range.clone());
	}
	for name in ["if-none-match", "if-modified-since"] {
		if let Some(value) = request.headers().get(name) {
			upstream_headers.insert(HeaderName::from_static(name), value.clone());
		}
	}
	if !upstream_headers.contains_key("user-agent") {
		if let Some(agent) = request.headers().get("user-agent") {
			upstream_headers.insert("user-agent", agent.clone());
		}
	}
	if host.contains("youtube") {
		upstream_headers.insert(
			"origin",
			HeaderValue::from_static("https://www.youtube.com"),
		);
		upstream_headers.insert(
			"referer",
			HeaderValue::from_static("https://www.youtube.com/"),
		);
	}
	upstream_headers.remove("host");
	if let Some(auth) = request.headers().get("authorization") {
		upstream_headers.insert("authorization", auth.clone());
	}

	let body = request.into_body();
	let mut upstream_request = client()
		.request(method, &target)
		.headers(upstream_headers);
	if !body.is_empty() {
		upstream_request = upstream_request.body(body);
	}

	let upstream_response = upstream_request.send().await.map_err(|e| e.to_string())?;
	let status = upstream_response.status();

	let mut passthrough = HeaderMap::new();
	for name in [
		"content-type",
		"content-disposition",
		"accept-ranges",
		"content-range",
		// Cache headers must reach the WebView so responses can be revalidated.
		"cache-control",
		"etag",
		"last-modified",
		"expires",
		"date",
		"age",
	] {
		if let Some(value) = upstream_response.headers().get(name) {
			passthrough.insert(HeaderName::from_static(name), value.clone());
		}
	}

	let freshness = image_freshness(upstream_response.headers());
	let is_image = is_image_response(upstream_response.headers());

	let bytes = upstream_response.bytes().await.map_err(|e| e.to_string())?;

	if cacheable_request
		&& status == StatusCode::OK
		&& is_image
		&& bytes.len() <= IMAGE_CACHE_MAX_ENTRY_BYTES
	{
		if let Some(freshness) = freshness {
			if let Ok(mut cache) = image_cache().lock() {
				let headers = passthrough
					.iter()
					.map(|(name, value)| {
						(
							name.to_string(),
							value.to_str().unwrap_or_default().to_owned(),
						)
					})
					.collect();
				cache.insert(
					target.clone(),
					CachedImage {
						status: status.as_u16(),
						headers,
						body: Arc::new(bytes.to_vec()),
						etag: passthrough
							.get("etag")
							.and_then(|value| value.to_str().ok())
							.map(String::from),
						fresh_until: Instant::now() + freshness,
						last_used: Instant::now(),
					},
				);
			}
		}
	}

	let mut response = Response::new(bytes.to_vec());
	*response.status_mut() = status;
	apply_cors(&mut response, &origin);
	response
		.headers_mut()
		.extend(
			passthrough
				.into_iter()
				.filter_map(|(name, value)| name.map(|name| (name, value))),
		);

	Ok(response)
}
