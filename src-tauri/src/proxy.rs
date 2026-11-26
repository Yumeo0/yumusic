use base64::Engine;
use std::time::Duration;

use serde_json::Value;
use tauri::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

#[path = "proxy_artwork.rs"]
mod artwork;

const ALLOWED_HEADERS: &str = "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-goog-visitor-id, x-goog-api-key, x-origin, x-youtube-client-version, x-youtube-client-name, x-goog-api-format-version, x-goog-authuser, x-user-agent, Accept-Language, X-Goog-FieldMask, Range, Referer, Cookie, X-Proxy-Headers, X-Proxy-Body";

async fn client() -> Result<&'static reqwest::Client, String> {
	static CLIENT: tokio::sync::OnceCell<reqwest::Client> = tokio::sync::OnceCell::const_new();
	CLIENT
		.get_or_try_init(|| async {
			super::http_client::builder()
				.await?
				.pool_max_idle_per_host(2)
				.pool_idle_timeout(Duration::from_secs(30))
				.build()
				.map_err(|e| e.to_string())
		})
		.await
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn https_client_initializes_without_panicking() {
		// A providerless TLS backend compiles but panics on the first proxy request.
		tauri::async_runtime::block_on(super::client()).expect("proxy HTTP client");
	}

	#[test]
	fn proxy_errors_remain_readable_across_origins() {
		for (uri, headers) in [
			("http://proxy.localhost/iframe_api", "{}"),
			(
				"http://proxy.localhost/iframe_api?__host=www.youtube.com",
				"invalid json",
			),
		] {
			let request = Request::builder()
				.uri(uri)
				.header("origin", "http://localhost:5173")
				.header("x-proxy-headers", headers)
				.body(Vec::new())
				.unwrap();
			let response = tauri::async_runtime::block_on(process_with_cors(request));
			assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
			assert_eq!(
				response.headers()["access-control-allow-origin"],
				"http://localhost:5173"
			);
			assert_eq!(
				response.headers()["access-control-allow-credentials"],
				"true"
			);
			assert!(!response.body().is_empty());
		}
	}

	#[test]
	fn proxy_preflight_allows_the_frontend_headers() {
		let request = Request::builder()
			.method(Method::OPTIONS)
			.uri("http://proxy.localhost/iframe_api?__host=www.youtube.com")
			.header("origin", "http://localhost:5173")
			.body(Vec::new())
			.unwrap();
		let response = tauri::async_runtime::block_on(process_with_cors(request));
		assert_eq!(response.status(), StatusCode::OK);
		assert_eq!(
			response.headers()["access-control-allow-origin"],
			"http://localhost:5173"
		);
		assert!(response.headers()["access-control-allow-headers"]
			.to_str()
			.unwrap()
			.contains("X-Proxy-Headers"));
	}

	#[test]
	#[ignore = "requires a live YouTube connection"]
	fn youtube_player_bootstrap_smoke_test() {
		let request = Request::builder()
			.uri("http://proxy.localhost/iframe_api?__host=www.youtube.com")
			.header("origin", "http://localhost:5173")
			.body(Vec::new())
			.unwrap();
		let response = tauri::async_runtime::block_on(process_with_cors(request));
		assert_eq!(
			response.status(),
			StatusCode::OK,
			"{}",
			String::from_utf8_lossy(response.body())
		);
		assert_eq!(
			response.headers()["access-control-allow-origin"],
			"http://localhost:5173"
		);
		assert!(String::from_utf8_lossy(response.body()).contains("YT"));
	}
}

pub fn handle<R: Runtime>(
	_ctx: UriSchemeContext<'_, R>,
	request: Request<Vec<u8>>,
	responder: UriSchemeResponder,
) {
	tauri::async_runtime::spawn(async move {
		let response = process_with_cors(request).await;
		responder.respond(response);
	});
}

async fn process_with_cors(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
	let origin = request
		.headers()
		.get("origin")
		.and_then(|value| value.to_str().ok())
		.unwrap_or_default()
		.to_owned();
	let mut response = process(request).await.unwrap_or_else(|error| {
		log::warn!("Proxy request failed: {error}");
		internal_error(error)
	});
	// Error paths bypass process()'s successful-response CORS setup. Without
	// this boundary the browser hides the actual error as "Failed to fetch".
	apply_cors(&mut response, &origin);
	response
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
	headers.insert("access-control-max-age", HeaderValue::from_static("86400"));
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
	let is_artwork = cacheable_request && artwork::is_artwork_host(&host);
	if cacheable_request {
		if let Some(response) = artwork::lookup(&request, &target, &origin) {
			return Ok(response);
		}
	}

	let permit = if is_artwork {
		match artwork::acquire(&target).await? {
			Some(permit) => Some(permit),
			None => return Ok(artwork::throttled_response(&origin)),
		}
	} else {
		None
	};

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
				let Some(value) = value.as_str() else {
					continue;
				};
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
	if host == "youtube.com" || host.ends_with(".youtube.com") || host.ends_with(".googlevideo.com")
	{
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

	let client = client().await?;
	let upstream_request = || {
		let request = client
			.request(method.clone(), &target)
			.headers(upstream_headers.clone());
		if body.is_empty() {
			request
		} else {
			request.body(body.clone())
		}
	};
	let upstream_response = if is_artwork {
		artwork::fetch(&target, upstream_request).await?
	} else {
		upstream_request()
			.send()
			.await
			.map_err(|error| format!("Upstream request failed: {error:?}"))?
	};
	let status = upstream_response.status();

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

	let freshness = cacheable_request
		.then(|| artwork::freshness(upstream_response.headers(), status))
		.flatten();
	let bytes = upstream_response.bytes().await.map_err(|e| e.to_string())?;
	drop(permit);
	if let Some(freshness) = freshness {
		artwork::store(target, &passthrough, &bytes, freshness);
	}

	let mut response = Response::new(bytes.to_vec());
	*response.status_mut() = status;
	apply_cors(&mut response, &origin);
	response.headers_mut().extend(
		passthrough
			.into_iter()
			.filter_map(|(name, value)| name.map(|name| (name, value))),
	);

	Ok(response)
}
