use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::http::{HeaderMap, Method, Request, Response, StatusCode};

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
	headers: HeaderMap,
	body: bytes::Bytes,
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
		while self.total_bytes > IMAGE_CACHE_MAX_BYTES
			|| self.entries.len() > IMAGE_CACHE_MAX_ENTRIES
		{
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

fn lookup(headers: &HeaderMap, target: &str) -> Option<Response<bytes::Bytes>> {
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

	if let (Some(inm), Some(etag)) = (headers.get("if-none-match"), entry.headers.get("etag")) {
		if inm == etag {
			let mut response = Response::new(bytes::Bytes::new());
			*response.status_mut() = StatusCode::NOT_MODIFIED;
			response.headers_mut().insert("etag", etag.clone());
			return Some(response);
		}
	}

	let mut response = Response::new(entry.body);
	*response.headers_mut() = entry.headers;
	Some(response)
}

pub(super) async fn serve<F>(
	request: &Request<Vec<u8>>,
	host: &str,
	target: &str,
	prepare: impl AsyncFnOnce() -> Result<F, String>,
) -> Result<Response<bytes::Bytes>, String>
where
	F: Fn() -> reqwest::RequestBuilder,
{
	let cacheable = request.method() == Method::GET && !request.headers().contains_key("range");
	if cacheable {
		if let Some(cached) = lookup(request.headers(), target) {
			return Ok(cached);
		}
	}
	let paced = cacheable && is_artwork_host(host);
	let permit = if paced {
		let Some(permit) = acquire(target).await? else {
			let mut response = Response::new(bytes::Bytes::new());
			*response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
			return Ok(response);
		};
		Some(permit)
	} else {
		None
	};
	let upstream = prepare().await?;
	let upstream = if paced {
		fetch(target, upstream).await?
	} else {
		send(upstream()).await?
	};
	let freshness = cacheable
		.then(|| freshness(upstream.headers(), upstream.status()))
		.flatten();
	let response = super::read_upstream(upstream).await?;
	drop(permit);
	if let Some(freshness) = freshness {
		store(
			target.to_owned(),
			response.headers(),
			response.body(),
			freshness,
		);
	}
	Ok(response)
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

/// Long cooldowns return `None` so image loads fail immediately.
fn image_cooldown_delay(target: &str) -> Option<Duration> {
	let now = Instant::now();
	let Ok(gate) = image_gate().lock() else {
		return Some(Duration::ZERO);
	};
	let global = gate.cooldown_until.saturating_duration_since(now);
	let target_wait = gate
		.target_cooldowns
		.get(target)
		.map_or(Duration::ZERO, |until| until.saturating_duration_since(now));
	let wait = global.max(target_wait);
	(wait <= COOLDOWN_WAIT_CAP).then_some(wait)
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

async fn acquire(target: &str) -> Result<Option<tokio::sync::SemaphorePermit<'static>>, String> {
	if image_cooldown_delay(target).is_none() {
		return Ok(None);
	}
	let permit = image_semaphore()
		.acquire()
		.await
		.map_err(|error| error.to_string())?;
	let Some(wait) = image_cooldown_delay(target) else {
		return Ok(None);
	};
	if !wait.is_zero() {
		tokio::time::sleep(wait).await;
	}
	Ok(Some(permit))
}

async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
	request
		.send()
		.await
		.map_err(|error| format!("Upstream request failed: {error:?}"))
}

async fn fetch(
	target: &str,
	request: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
	let mut attempt = 1;
	loop {
		let response = send(request().timeout(IMAGE_TIMEOUT)).await?;
		let status = response.status();
		let throttled = status == StatusCode::TOO_MANY_REQUESTS;
		if attempt == MAX_IMAGE_ATTEMPTS || !(throttled || status.is_server_error()) {
			if throttled {
				mark_image_throttled(Some(target));
			}
			return Ok(response);
		}
		if throttled {
			mark_image_throttled(None);
		}
		tokio::time::sleep(image_backoff(status, response.headers(), attempt)).await;
		attempt += 1;
	}
}

fn freshness(headers: &HeaderMap, status: StatusCode) -> Option<Duration> {
	if status != StatusCode::OK || !is_image_response(headers) {
		return None;
	}
	image_freshness(headers)
}

fn store(target: String, headers: &HeaderMap, bytes: &bytes::Bytes, freshness: Duration) {
	if bytes.len() > IMAGE_CACHE_MAX_ENTRY_BYTES {
		return;
	}
	let Ok(mut cache) = image_cache().lock() else {
		return;
	};
	let now = Instant::now();
	cache.insert(
		target,
		CachedImage {
			headers: headers.clone(),
			body: bytes.clone(),
			fresh_until: now + freshness,
			last_used: now,
		},
	);
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cached_artwork_supports_etags_and_never_answers_range_requests() {
		let target = "https://i.ytimg.com/artwork-cache-test";
		let mut headers = HeaderMap::new();
		headers.insert("etag", "\"test-cover\"".parse().unwrap());
		store(
			target.to_owned(),
			&headers,
			&bytes::Bytes::from_static(b"artwork"),
			Duration::from_secs(60),
		);
		tauri::async_runtime::block_on(async {
			let request = Request::new(Vec::new());
			let upstream = async || -> Result<fn() -> reqwest::RequestBuilder, String> {
				Err("needs upstream".to_owned())
			};
			let response = serve(&request, "i.ytimg.com", target, upstream)
				.await
				.unwrap();
			assert_eq!(response.status(), StatusCode::OK);
			assert_eq!(&response.body()[..], b"artwork");
			let request = Request::builder()
				.header("if-none-match", "\"test-cover\"")
				.body(Vec::new())
				.unwrap();
			let response = serve(&request, "i.ytimg.com", target, upstream)
				.await
				.unwrap();
			assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
			assert!(response.body().is_empty());
			let request = Request::builder()
				.header("range", "bytes=0-1")
				.body(Vec::new())
				.unwrap();
			assert_eq!(
				serve(&request, "i.ytimg.com", target, upstream)
					.await
					.unwrap_err(),
				"needs upstream"
			);
		});
	}

	fn image(size: usize, age: Duration) -> CachedImage {
		CachedImage {
			headers: HeaderMap::new(),
			body: bytes::Bytes::from(vec![0; size]),
			fresh_until: Instant::now() + age,
			last_used: Instant::now(),
		}
	}

	#[test]
	fn image_cache_replacement_and_expiry_release_their_byte_budget() {
		let mut cache = ImageCache {
			entries: HashMap::new(),
			total_bytes: 0,
		};
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
		let mut cache = ImageCache {
			entries: HashMap::new(),
			total_bytes: 0,
		};
		cache.insert(
			"old".into(),
			image(IMAGE_CACHE_MAX_BYTES / 2, Duration::from_secs(60)),
		);
		cache.insert(
			"new".into(),
			image(IMAGE_CACHE_MAX_BYTES / 2 + 1, Duration::from_secs(60)),
		);
		assert!(!cache.entries.contains_key("old"));
		assert!(cache.total_bytes <= IMAGE_CACHE_MAX_BYTES);
	}
}
