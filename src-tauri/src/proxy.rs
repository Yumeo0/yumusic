use base64::Engine;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

const ALLOWED_HEADERS: &str = "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-goog-visitor-id, x-goog-api-key, x-origin, x-youtube-client-version, x-youtube-client-name, x-goog-api-format-version, x-goog-authuser, x-user-agent, Accept-Language, X-Goog-FieldMask, Range, Referer, Cookie, X-Proxy-Headers, X-Proxy-Body";

/// Artwork CDN hosts. Upstream throttles these aggressively (429), so their
/// GETs are paced, retried with backoff and cooled down individually.
fn is_artwork_host(host: &str) -> bool {
	host.ends_with("ytimg.com")
		|| host.ends_with("googleusercontent.com")
		|| host.ends_with("ggpht.com")
}

/// Max concurrent upstream artwork fetches: turns the webview's parallel
/// grid-load burst into a paced stream so the CDN's burst limit isn't hit.
const IMAGE_FETCH_CONCURRENCY: usize = 4;
/// 1 initial attempt + 3 retries on 429/5xx.
const MAX_IMAGE_ATTEMPTS: usize = 4;
const MIN_BACKOFF: Duration = Duration::from_millis(750);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
/// A 429 mid-flight pauses *all* artwork fetches briefly.
const GLOBAL_COOLDOWN: Duration = Duration::from_secs(2);
/// After exhausting retries for one image, fail fast for other requests to
/// it instead of re-hitting upstream (the <img> stays broken either way).
const PER_TARGET_COOLDOWN: Duration = Duration::from_secs(30);
/// Cooldown windows this long are failed fast instead of waited out.
const COOLDOWN_WAIT_CAP: Duration = Duration::from_secs(5);
const IMAGE_TIMEOUT: Duration = Duration::from_secs(30);

/// In-memory cache for proxied images, bounded by total bytes with LRU
/// eviction. Needed because custom-scheme responses are not kept in the
/// WebView's HTTP cache, so every proxied image would otherwise be
/// re-fetched upstream on every display — the main source of 429s.
const IMAGE_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const IMAGE_CACHE_MAX_ENTRY_BYTES: usize = 1024 * 1024;
const IMAGE_CACHE_MAX_ENTRIES: usize = 512;
const IMAGE_FRESHNESS_FALLBACK: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const IMAGE_FRESHNESS_CAP: u64 = 30 * 24 * 60 * 60;

#[derive(Clone)]
struct CachedImage {
	status: u16,
	headers: Vec<(String, String)>,
	body: bytes::Bytes,
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
		let now = Instant::now();
		self.entries.retain(|_, cached| {
			if cached.fresh_until <= now {
				self.total_bytes -= cached.body.len();
				false
			} else {
				true
			}
		});
		if let Some(previous) = self.entries.remove(&key) {
			self.total_bytes -= previous.body.len();
		}
		self.total_bytes += entry.body.len();
		self.entries.insert(key, entry);
		while self.total_bytes > IMAGE_CACHE_MAX_BYTES || self.entries.len() > IMAGE_CACHE_MAX_ENTRIES {
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

	let mut response = Response::new(entry.body.to_vec());
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
	CLIENT.get_or_init(|| {
		reqwest::Client::builder()
			.pool_max_idle_per_host(2)
			.pool_idle_timeout(Duration::from_secs(30))
			.build()
			.expect("proxy HTTP client")
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn image(size: usize, age: Duration) -> CachedImage {
		CachedImage {
			status: 200,
			headers: vec![],
			body: bytes::Bytes::from(vec![0; size]),
			etag: None,
			fresh_until: Instant::now() + age,
			last_used: Instant::now(),
		}
	}

	#[test]
	fn image_cache_replacement_and_expiry_release_their_byte_budget() {
		let mut cache = ImageCache { entries: HashMap::new(), total_bytes: 0 };
		cache.insert("cover".into(), image(100, Duration::from_secs(60)));
		cache.insert("cover".into(), image(20, Duration::from_secs(60)));
		assert_eq!(cache.total_bytes, 20);
		cache.insert("expired".into(), image(100, Duration::ZERO));
		cache.insert("fresh".into(), image(30, Duration::from_secs(60)));
		assert_eq!(cache.total_bytes, 50);
		assert!(!cache.entries.contains_key("expired"));
	}

	#[test]
	fn image_cache_evicts_the_least_recently_used_data() {
		let mut cache = ImageCache { entries: HashMap::new(), total_bytes: 0 };
		cache.insert("old".into(), image(IMAGE_CACHE_MAX_BYTES / 2, Duration::from_secs(60)));
		cache.insert("new".into(), image(IMAGE_CACHE_MAX_BYTES / 2 + 1, Duration::from_secs(60)));
		assert!(!cache.entries.contains_key("old"));
		assert!(cache.total_bytes <= IMAGE_CACHE_MAX_BYTES);
	}

	#[test]
	fn https_client_initializes_without_panicking() {
		// A providerless TLS backend compiles but panics on the first proxy request.
		let _ = super::client();
	}
}

/// Pacing state for artwork fetches: a global pause window when upstream
/// signals 429, plus per-target fail-fast cooldowns. Concurrency is paced
/// separately via [`image_semaphore`].
struct ImageGate {
	cooldown_until: Instant,
	target_cooldowns: HashMap<String, Instant>,
}

fn image_gate() -> &'static Mutex<ImageGate> {
	static GATE: OnceLock<Mutex<ImageGate>> = OnceLock::new();
	GATE.get_or_init(|| {
		Mutex::new(ImageGate {
			cooldown_until: Instant::now(),
			target_cooldowns: HashMap::new(),
		})
	})
}

fn image_semaphore() -> &'static tokio::sync::Semaphore {
	static SEMAPHORE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
	SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(IMAGE_FETCH_CONCURRENCY))
}

/// How long an upstream artwork fetch must wait before it may start:
/// `Some(Some(wait))` to sleep out a short cooldown, `Some(None)` when the
/// target is in a long cooldown (caller should fail fast), `None` when the
/// fetch may start immediately.
fn image_cooldown_delay(target: &str) -> Option<Option<Duration>> {
	let now = Instant::now();
	let gate = image_gate().lock().ok()?;
	let global = gate.cooldown_until.saturating_duration_since(now);
	let target_wait = gate
		.target_cooldowns
		.get(target)
		.map_or(Duration::ZERO, |until| {
			until.saturating_duration_since(now)
		});
	if global > COOLDOWN_WAIT_CAP || target_wait > COOLDOWN_WAIT_CAP {
		return Some(None);
	}
	Some(Some(global.max(target_wait)))
}

/// Records an upstream 429: pauses all artwork fetches briefly and, when
/// `per_target`, blocks further upstream attempts for that image.
fn mark_image_throttled(target: Option<&str>) {
	let now = Instant::now();
	if let Ok(mut gate) = image_gate().lock() {
		let new_until = now + GLOBAL_COOLDOWN;
		if new_until > gate.cooldown_until {
			gate.cooldown_until = new_until;
		}
		if let Some(target) = target {
			gate.target_cooldowns.retain(|_, until| *until > now);
			gate.target_cooldowns
				.insert(target.to_owned(), now + PER_TARGET_COOLDOWN);
		}
	}
}

/// Response used when a request hits an image in a long 429 cooldown.
fn throttled_response(origin: &str) -> Response<Vec<u8>> {
	let mut response = Response::new(Vec::new());
	*response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
	apply_cors(&mut response, origin);
	response
}

/// Backoff before retrying a throttled/failed artwork fetch: honors
/// `Retry-After` for 429s, otherwise exponential (0.75s, 1.5s, 3s, …).
fn image_backoff(status: StatusCode, headers: &HeaderMap, attempt: usize) -> Duration {
	if status == StatusCode::TOO_MANY_REQUESTS {
		if let Some(seconds) = headers
			.get("retry-after")
			.and_then(|value| value.to_str().ok())
			.and_then(|value| value.trim().parse::<u64>().ok())
		{
			return Duration::from_secs(seconds.min(MAX_BACKOFF.as_secs()).max(1));
		}
	}
	let shift = (attempt - 1).min(4) as u32;
	Duration::from_millis((MIN_BACKOFF.as_millis() as u64).saturating_mul(1 << shift))
		.min(MAX_BACKOFF)
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
	// The resumable upload session id lives in a response header; expose it
	// (and its legacy spelling) so the WebView can read it.
	headers.insert(
		"access-control-expose-headers",
		HeaderValue::from_static("X-Goog-Upload-Id, X-Guploader-Uploadid"),
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
	let is_artwork = cacheable_request && is_artwork_host(&host);
	if cacheable_request {
		if let Some(response) = cache_lookup(&request, &target, &origin) {
			return Ok(response);
		}
	}

	// Pace artwork fetches: ride out short cooldown windows, fail fast for
	// targets in a long cooldown, then take one of the limited fetch slots.
	let mut permit: Option<tokio::sync::SemaphorePermit<'static>> = None;
	if is_artwork {
		match image_cooldown_delay(&target) {
			Some(None) => return Ok(throttled_response(&origin)),
			Some(Some(wait)) if wait > Duration::ZERO => {
				tokio::time::sleep(wait).await;
			}
			_ => {}
		}
		permit = Some(
			image_semaphore()
				.acquire()
				.await
				.map_err(|e| e.to_string())?,
		);
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

	// Android's WebView API (shouldInterceptRequest) does not expose request
	// bodies to custom protocol handlers, so wry always hands us an empty body
	// there. The frontend works around this by sending the body base64-encoded
	// in the X-Proxy-Body header; fall back to it when the body is empty.
	let proxy_body = request
		.headers()
		.get("x-proxy-body")
		.and_then(|value| value.to_str().ok())
		.map(String::from);
	let mut body = request.into_body();
	if body.is_empty() {
		if let Some(encoded) = proxy_body {
			if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(encoded) {
				body = decoded;
			}
		}
	}

	// Artwork hosts throttle hard (429), so their fetches are retried with
	// backoff while paced through the shared semaphore; other requests are
	// sent once, untouched.
	let upstream_response = {
		let mut attempt = 0usize;
		loop {
			let mut upstream_request = client()
				.request(method.clone(), &target)
				.headers(upstream_headers.clone());
			if !body.is_empty() {
				upstream_request = upstream_request.body(body.clone());
			}
			if is_artwork {
				upstream_request = upstream_request.timeout(IMAGE_TIMEOUT);
			}

			let response = upstream_request.send().await.map_err(|e| e.to_string())?;
			let status = response.status();
			let retryable = status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
			if !is_artwork || !retryable || attempt + 1 >= MAX_IMAGE_ATTEMPTS {
				break response;
			}
			attempt += 1;
			if status == StatusCode::TOO_MANY_REQUESTS {
				// Pause other artwork fetches too; we're in a throttle window.
				mark_image_throttled(None);
			}
			tokio::time::sleep(image_backoff(status, response.headers(), attempt)).await;
		}
	};
	let status = upstream_response.status();
	if is_artwork && status == StatusCode::TOO_MANY_REQUESTS {
		// Retries exhausted: fail fast for further requests to this image.
		mark_image_throttled(Some(&target));
	}

	let mut passthrough = HeaderMap::new();
	for name in [
		"content-type",
		"content-disposition",
		"accept-ranges",
		"content-range",
		// Resumable uploads: the session id must reach the WebView.
		"x-goog-upload-id",
		"x-guploader-uploadid",
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
	drop(permit);

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
						body: bytes.clone(),
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
