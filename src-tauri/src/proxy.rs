use std::sync::OnceLock;

use serde_json::Value;
use tauri::http::{HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext, UriSchemeResponder};

const ALLOWED_HEADERS: &str = "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-goog-visitor-id, x-goog-api-key, x-origin, x-youtube-client-version, x-youtube-client-name, x-goog-api-format-version, x-goog-authuser, x-user-agent, Accept-Language, X-Goog-FieldMask, Range, Referer, Cookie, X-Proxy-Headers";

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

	let method = request.method().clone();
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
	] {
		if let Some(value) = upstream_response.headers().get(name) {
			passthrough.insert(HeaderName::from_static(name), value.clone());
		}
	}

	let bytes = upstream_response.bytes().await.map_err(|e| e.to_string())?;
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
