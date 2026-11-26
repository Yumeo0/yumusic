//! Renew exported YouTube cookies through the existing browser session.
use std::future::Future;
use std::sync::{atomic::Ordering, Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};

use super::{login_session, session_window};

const WINDOW: &str = "session-refresh";
const YOUTUBE_TIMEOUT: Duration = Duration::from_secs(10);
const GOOGLE_TIMEOUT: Duration = Duration::from_secs(20);

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
	if !is_current(revision) {
		return Err("Session recovery cancelled".into());
	}
	let finished = Arc::new(Mutex::new(None::<Url>));
	let on_load = finished.clone();
	let builder = session_window(app, WINDOW, Url::parse("about:blank").unwrap())
		.title("Google session recovery")
		.visible(false)
		.focused(false)
		.on_navigation(|url| {
			url.as_str() == "about:blank"
				|| login_session::is_youtube_page(url)
				|| (url.scheme() == "https"
					&& matches!(
						url.host_str(),
						Some(
							"accounts.google.com"
								| "accounts.youtube.com"
								| "youtube.com"
								| "consent.google.com"
								| "consent.youtube.com"
						)
					))
		})
		.on_page_load(move |_, payload| {
			if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
				*on_load.lock().unwrap() = Some(payload.url().clone());
			}
		});
	let window = builder.build().map_err(|e| e.to_string())?;
	let result = recover_by_navigation(|url, timeout| {
		let window = &window;
		let finished = &*finished;
		async move {
			if !is_current(revision) {
				return Err("Session recovery cancelled".into());
			}
			*finished.lock().unwrap() = None;
			window.navigate(url).map_err(|e| e.to_string())?;
			wait_for_cookies(window, verifier, finished, revision, timeout).await
		}
	})
	.await;
	let _ = window.destroy();
	if !is_current(revision) {
		return Err("Session recovery cancelled".into());
	}
	result
}

fn is_current(revision: u64) -> bool {
	super::AUTH_REVISION.load(Ordering::SeqCst) == revision
}

async fn recover_by_navigation<F>(
	mut visit: impl FnMut(Url, Duration) -> F,
) -> Result<Option<String>, String>
where
	F: Future<Output = Result<Option<String>, String>>,
{
	let youtube = Url::parse(login_session::YOUTUBE_MUSIC_URL).unwrap();
	// A first-party page can rotate YouTube cookies even when Google's sign-in
	// URL opens a prompt. Let the browser use the existing session first.
	if let Ok(Some(cookie)) = visit(youtube.clone(), YOUTUBE_TIMEOUT).await {
		return Ok(Some(cookie));
	}
	if let Some(cookie) = visit(login_session::google_login_url()?, GOOGLE_TIMEOUT).await? {
		return Ok(Some(cookie));
	}
	// Google can update shared cookies before showing the sign-in prompt.
	Ok(visit(youtube, YOUTUBE_TIMEOUT).await.unwrap_or(None))
}

async fn wait_for_cookies(
	window: &tauri::WebviewWindow,
	verifier: &reqwest::Client,
	finished: &Mutex<Option<Url>>,
	revision: u64,
	timeout: Duration,
) -> Result<Option<String>, String> {
	let mut rejected = false;
	let result = tokio::time::timeout(timeout, async {
		loop {
			if !is_current(revision) || window.app_handle().get_webview_window(WINDOW).is_none() {
				return Err("Session recovery cancelled".into());
			}
			tokio::time::sleep(Duration::from_millis(500)).await;
			let url = window.url().map_err(|e| e.to_string())?;
			let loaded = finished.lock().unwrap().as_ref() == Some(&url);
			if !loaded || !login_session::is_youtube_page(&url) {
				continue;
			}
			let cookie = super::collect_login_cookies(window)?;
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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn renewed_youtube_session_skips_google_login() {
		let result = tauri::async_runtime::block_on(recover_by_navigation(|url, _| async move {
			assert_eq!(url.as_str(), login_session::YOUTUBE_MUSIC_URL);
			Ok(Some("renewed-cookie".into()))
		}));
		assert_eq!(result, Ok(Some("renewed-cookie".into())));
	}

	#[test]
	fn falls_back_to_google_when_youtube_cannot_renew_the_session() {
		let mut hosts = Vec::new();
		let result = tauri::async_runtime::block_on(recover_by_navigation(|url, _| {
			let host = url.host_str().unwrap().to_owned();
			hosts.push(host.clone());
			async move {
				match host.as_str() {
					"music.youtube.com" => Err("YouTube session recovery timed out".into()),
					"accounts.google.com" => Ok(Some("renewed-cookie".into())),
					_ => panic!("Unexpected login navigation"),
				}
			}
		}));
		assert_eq!(result, Ok(Some("renewed-cookie".into())));
		assert_eq!(hosts, ["music.youtube.com", "accounts.google.com"]);
	}

	#[test]
	fn retries_youtube_after_google_shows_a_sign_in_prompt() {
		let mut hosts = Vec::new();
		let result = tauri::async_runtime::block_on(recover_by_navigation(|url, _| {
			hosts.push(url.host_str().unwrap().to_owned());
			let cookie = (hosts.len() == 3).then(|| "renewed-cookie".into());
			async move { Ok(cookie) }
		}));
		assert_eq!(result, Ok(Some("renewed-cookie".into())));
		assert_eq!(
			hosts,
			[
				"music.youtube.com",
				"accounts.google.com",
				"music.youtube.com"
			]
		);
	}
}
