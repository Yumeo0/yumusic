#[cfg(not(target_os = "android"))]
use std::{
	collections::HashMap,
	sync::{Arc, Mutex, OnceLock},
	time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
#[cfg(not(target_os = "android"))]
use tokio::sync::oneshot;

#[cfg(target_os = "android")]
#[path = "po_token_android.rs"]
mod android;

#[cfg(not(target_os = "android"))]
const WINDOW: &str = "po-token";
const MINT_SCRIPT: &str = concat!(
	include_str!(concat!(env!("OUT_DIR"), "/po_token_bgutils.js")),
	"\n",
	include_str!("po_token_bridge.js"),
);
#[cfg(not(target_os = "android"))]
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;
static MINT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(target_os = "windows")]
static WINDOW_ACTIVITY: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(target_os = "windows")]
const WINDOW_IDLE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoToken {
	token: String,
	context: Value,
	account_index: u64,
	cookie: String,
}

// Minting is serialized so requests can reuse the ready minter.
#[tauri::command]
pub async fn mint_po_token(app: AppHandle, binding: String) -> Result<PoToken, String> {
	if binding.is_empty() || binding.len() > 1024 {
		return Err("Invalid PO token binding".into());
	}
	let _lock = MINT_LOCK.lock().await;
	#[cfg(target_os = "android")]
	{
		let _ = app;
		return android::mint(binding).await;
	}
	#[cfg(target_os = "windows")]
	{
		use std::sync::atomic::Ordering::Relaxed;

		let activity = WINDOW_ACTIVITY.fetch_add(1, Relaxed).wrapping_add(1);
		let result = mint_in_window(app.clone(), binding).await;
		// Keep the minter warm for the next playback request. An active mint or
		// account change supersedes this timer, and visible consent stays open.
		tauri::async_runtime::spawn(async move {
			tokio::time::sleep(WINDOW_IDLE_TIMEOUT).await;
			let _lock = MINT_LOCK.lock().await;
			if WINDOW_ACTIVITY.load(Relaxed) == activity {
				if let Some(window) = app.get_webview_window(WINDOW) {
					if matches!(window.is_visible(), Ok(false)) {
						let _ = window.destroy();
					}
				}
			}
		});
		return result;
	}
	#[cfg(not(any(target_os = "android", target_os = "windows")))]
	mint_in_window(app, binding).await
}

#[cfg(not(target_os = "android"))]
async fn mint_in_window(app: AppHandle, binding: String) -> Result<PoToken, String> {
	static PENDING: OnceLock<Pending> = OnceLock::new();
	static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
	let pending = PENDING.get_or_init(Default::default).clone();
	let window = if let Some(window) = app.get_webview_window(WINDOW) {
		window
	} else {
		let callback = pending.clone();
		let navigation_app = app.clone();
		let url = WebviewUrl::External(Url::parse("https://www.youtube.com/robots.txt").unwrap());
		let mut builder = WebviewWindowBuilder::new(&app, WINDOW, url)
			.title("YouTube playback attestation")
			.visible(false)
			.focused(false)
			.initialization_script(MINT_SCRIPT)
			.on_navigation(move |url| {
				if url.scheme() == "yumusic-po" && url.host_str() == Some("result") {
					if let Some((_, payload)) = url.query_pairs().find(|(key, _)| key == "payload")
					{
						if let Ok(value) = serde_json::from_str::<Value>(&payload) {
							if let Some(id) = value.get("id").and_then(Value::as_str) {
								if let Some(sender) = callback.lock().unwrap().remove(id) {
									let _ = sender.send(value);
								}
							}
						}
					}
					return false;
				}
				// Consent requires a visible page; never make a choice for the user.
				if matches!(
					url.host_str(),
					Some("consent.youtube.com" | "consent.google.com")
				) {
					if let Some(window) = navigation_app.get_webview_window(WINDOW) {
						let _ = window.show();
					}
				}
				url.scheme() == "https"
					&& matches!(
						url.host_str(),
						Some(
							"www.youtube.com"
								| "consent.youtube.com"
								| "consent.google.com"
								| "accounts.google.com"
						)
					)
			});
		if let Some(args) = app
			.config()
			.app
			.windows
			.iter()
			.find(|config| config.label == "main")
			.and_then(|config| config.additional_browser_args.clone())
		{
			builder = builder.additional_browser_args(&args);
		}
		builder.build().map_err(|e| e.to_string())?
	};
	let id = NEXT_ID
		.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
		.to_string();
	let (sender, mut receiver) = oneshot::channel();
	pending.lock().unwrap().insert(id.clone(), sender);
	let script = format!(
		"window.__yumusicMintPoToken?.({}, {})",
		serde_json::to_string(&id).unwrap(),
		serde_json::to_string(&binding).unwrap()
	);
	let result = tokio::time::timeout(Duration::from_secs(35), async {
		loop {
			window.eval(&script).map_err(|e| e.to_string())?;
			if let Ok(result) =
				tokio::time::timeout(Duration::from_millis(250), &mut receiver).await
			{
				break result.map_err(|e| e.to_string());
			}
		}
	})
	.await;
	pending.lock().unwrap().remove(&id);
	let value = match result {
		Ok(Ok(value)) => value,
		failure => {
			// Discard a stuck hidden page so the next attempt starts a fresh minter.
			// A visible consent page stays available for the user to complete.
			if !window.is_visible().unwrap_or(false) {
				let _ = window.close();
			}
			return Err(match failure {
				Ok(Err(error)) => error,
				_ => "YouTube PO token minting timed out".to_string(),
			});
		}
	};
	if let Some(error) = value.get("error").and_then(Value::as_str) {
		return Err(error.to_owned());
	}
	let token = value
		.get("token")
		.and_then(Value::as_str)
		.filter(|token| !token.is_empty())
		.ok_or("YouTube did not return a PO token")?
		.to_owned();
	let _ = window.hide();
	let context = value
		.get("context")
		.filter(|context| context["client"]["visitorData"].is_string())
		.ok_or("YouTube did not return a visitor context")?
		.clone();
	let url = Url::parse("https://www.youtube.com/").unwrap();
	let cookies = window.cookies_for_url(url).map_err(|e| e.to_string())?;
	let cookie = super::dedup_cookie_header(
		&cookies
			.iter()
			.map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
			.collect::<Vec<_>>()
			.join("; "),
	);
	Ok(PoToken {
		token,
		context,
		account_index: value["accountIndex"].as_u64().unwrap_or(0),
		cookie,
	})
}

pub fn reset(app: &AppHandle) {
	#[cfg(target_os = "windows")]
	WINDOW_ACTIVITY.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
	#[cfg(target_os = "android")]
	{
		let _ = app;
		android::reset();
	}
	#[cfg(not(target_os = "android"))]
	if let Some(window) = app.get_webview_window(WINDOW) {
		let _ = window.close();
	}
}
