//! Renew exported YouTube cookies through the existing Google browser session.
//! This is the same navigation as Login, without interrupting the main window.
use std::sync::{atomic::Ordering, Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use super::login_session;

const WINDOW: &str = "session-refresh";

pub fn cancel(app: &AppHandle) {
	if let Some(window) = app.get_webview_window(WINDOW) {
		let _ = window.destroy();
	}
}

pub async fn refresh(
	app: &AppHandle,
	verifier: &reqwest::Client,
	revision: u64,
) -> Result<Option<String>, String> {
	let is_current = || super::AUTH_REVISION.load(Ordering::SeqCst) == revision;
	if !is_current() {
		return Err("Session recovery cancelled".into());
	}
	let finished = Arc::new(Mutex::new(None::<Url>));
	let on_load = finished.clone();
	let mut builder = WebviewWindowBuilder::new(
		app,
		WINDOW,
		WebviewUrl::External(login_session::google_login_url()?),
	)
	.title("Google session recovery")
	.visible(false)
	.focused(false)
	.on_navigation(|url| {
		login_session::is_youtube_page(url)
			|| (url.scheme() == "https"
				&& matches!(
					url.host_str(),
					Some(
						"accounts.google.com"
							| "accounts.youtube.com"
							| "youtube.com" | "consent.google.com"
							| "consent.youtube.com"
					)
				))
	})
	.on_page_load(move |_, payload| {
		if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
			*on_load.lock().unwrap() = Some(payload.url().clone());
		}
	});
	// WebView2 requires identical arguments for windows sharing a cookie store.
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
	let window = builder.build().map_err(|e| e.to_string())?;
	let mut rejected = false;
	let result = tokio::time::timeout(Duration::from_secs(20), async {
		loop {
			if !is_current() || app.get_webview_window(WINDOW).is_none() {
				return Err("Session recovery cancelled".into());
			}
			tokio::time::sleep(Duration::from_millis(500)).await;
			let url = window.url().map_err(|e| e.to_string())?;
			let loaded = finished.lock().unwrap().as_ref() == Some(&url);
			if !loaded || !login_session::is_youtube_page(&url) {
				continue;
			}
			let cookie = super::collect_login_cookies(&window)?;
			if !login_session::has_login_cookies(&cookie) {
				continue;
			}
			if login_session::verify_login(verifier, &cookie).await? {
				return Ok(Some(cookie));
			}
			rejected = true;
			// Give page scripts time to finish rotating the session cookies.
			tokio::time::sleep(Duration::from_secs(2)).await;
		}
	})
	.await;
	// Always discard the temporary page, including on network failure or timeout.
	let _ = window.destroy();
	if !is_current() {
		return Err("Session recovery cancelled".into());
	}
	match result {
		Ok(result) => result,
		Err(_) => {
			let needs_login = finished.lock().unwrap().as_ref().is_some_and(|url| {
				url.scheme() == "https" && url.host_str() == Some("accounts.google.com")
			});
			if rejected || needs_login {
				Ok(None)
			} else {
				// Consent, network failures and unknown pages are inconclusive.
				Err("Google session recovery timed out".into())
			}
		}
	}
}
