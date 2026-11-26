use crate::{http_client, login_session, po_token};
#[cfg(desktop)]
#[path = "session_refresh.rs"]
mod session_refresh;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

fn session_window<'a, R: tauri::Runtime>(
	app: &'a AppHandle<R>,
	label: &str,
	url: Url,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
	let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url));
	// WebView2 requires identical browser arguments for a shared user data folder.
	match app
		.config()
		.app
		.windows
		.iter()
		.find(|config| config.label == "main")
		.and_then(|config| config.additional_browser_args.as_deref())
	{
		Some(args) => builder.additional_browser_args(args),
		None => builder,
	}
}

static AUTH_REVISION: AtomicU64 = AtomicU64::new(0);
// Keep the final recovery check/write atomic with logout and new logins.
static AUTH_MUTATION: Mutex<()> = Mutex::new(());

fn cookie_path(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
	fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir.join("cookie.json"))
}

fn read_cookie(app: &AppHandle) -> Result<Option<String>, String> {
	let path = cookie_path(app)?;
	if !path.exists() {
		return Ok(None);
	}
	let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
	let value: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
	Ok(value
		.get("cookie")
		.and_then(|cookie| cookie.as_str())
		.map(login_session::dedup_cookie_header))
}

fn write_cookie(app: &AppHandle, cookie: &str) -> Result<(), String> {
	let path = cookie_path(app)?;
	let data = serde_json::to_string(&serde_json::json!({ "cookie": cookie }))
		.map_err(|e| e.to_string())?;
	fs::write(&path, data).map_err(|e| e.to_string())
}

/// The shared webview cookie store's Google/YouTube cookies joined into one
/// header value. All origins carry the same session; duplicate names are
/// dropped, keeping the first occurrence.
fn collect_login_cookies<R: tauri::Runtime>(
	window: &tauri::WebviewWindow<R>,
) -> Result<String, String> {
	let urls = [
		Url::parse("https://www.youtube.com/").map_err(|e| e.to_string())?,
		Url::parse("https://m.youtube.com/").map_err(|e| e.to_string())?,
		Url::parse("https://music.youtube.com/").map_err(|e| e.to_string())?,
	];
	let mut seen = std::collections::HashSet::new();
	let mut parts: Vec<String> = Vec::new();
	for url in urls {
		if let Ok(cookies) = window.cookies_for_url(url) {
			for cookie in cookies {
				if seen.insert(cookie.name().to_string()) {
					parts.push(format!("{}={}", cookie.name(), cookie.value()));
				}
			}
		}
	}
	Ok(parts.join("; "))
}

#[tauri::command]
pub fn get_cookie(app: AppHandle) -> Result<Option<String>, String> {
	read_cookie(&app)
}

#[tauri::command]
pub async fn logout(app: AppHandle) -> Result<bool, String> {
	{
		let _mutation = AUTH_MUTATION.lock().map_err(|e| e.to_string())?;
		AUTH_REVISION.fetch_add(1, Ordering::SeqCst);
		#[cfg(desktop)]
		session_refresh::cancel(&app);
		po_token::reset(&app);
		let path = cookie_path(&app)?;
		if path.exists() {
			fs::remove_file(&path).map_err(|e| e.to_string())?;
		}
	}
	#[cfg(target_os = "android")]
	{
		// wry's delete_cookie is a no-op on Android. Clear the app-owned
		// CookieManager directly, without touching localStorage or app settings.
		let (tx, rx) = tokio::sync::oneshot::channel();
		tauri_runtime_wry::wry::prelude::dispatch(move |env, _, _| {
			let result = (|| {
				let manager = env
					.call_static_method(
						"android/webkit/CookieManager",
						"getInstance",
						"()Landroid/webkit/CookieManager;",
						&[],
					)?
					.l()?;
				// The legacy synchronous API lets logout finish only after removal.
				env.call_method(&manager, "removeAllCookie", "()V", &[])?;
				env.call_method(&manager, "flush", "()V", &[])?;
				Ok::<(), tauri_runtime_wry::wry::prelude::jni::errors::Error>(())
			})();
			let _ = tx.send(result.map_err(|e| e.to_string()));
		});
		rx.await.map_err(|e| e.to_string())??;
	}
	#[cfg(not(target_os = "android"))]
	{
		// The login webview shares the main window's cookie store. Removing only
		// cookie.json lets the next login immediately capture the same stale session.
		let window = app
			.get_webview_window("main")
			.ok_or("Main window not found")?;
		for origin in [
			"https://google.com/",
			"https://accounts.google.com/",
			"https://www.google.com/",
			"https://youtube.com/",
			"https://www.youtube.com/",
			"https://m.youtube.com/",
			"https://music.youtube.com/",
			"https://accounts.youtube.com/",
		] {
			let url = Url::parse(origin).map_err(|e| e.to_string())?;
			for cookie in window.cookies_for_url(url).map_err(|e| e.to_string())? {
				window.delete_cookie(cookie).map_err(|e| e.to_string())?;
			}
		}
	}
	Ok(true)
}

/// Client used to ask YouTube whether a cookie session is still signed in.
/// The desktop user agent keeps the response on the page shape
/// the session verifier reads.
async fn session_verifier() -> Result<reqwest::Client, String> {
	http_client::builder()
		.await?
		.timeout(Duration::from_secs(10))
		.user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
		.build()
		.map_err(|e| e.to_string())
}

/// A profile lookup can fail while the Google session is still valid. Only
/// YouTube's explicit verdict marks it expired, and never erase credentials
/// here: the shared browser store may still recover the session later.
#[tauri::command]
pub async fn validate_session(app: AppHandle) -> Result<Option<String>, String> {
	// Multiple callers must not create competing recovery windows.
	static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
	let _lock = LOCK.lock().await;
	let revision = AUTH_REVISION.load(Ordering::SeqCst);
	let Some(saved) = read_cookie(&app)? else {
		return Ok(None);
	};
	let verifier = session_verifier().await?;
	let recovered = login_session::recover_login(
		&saved,
		|cookie| {
			let verifier = &verifier;
			async move { login_session::verify_login(verifier, &cookie).await }
		},
		|| {
			app.get_webview_window("main")
				.map(|window| collect_login_cookies(&window))
				.unwrap_or_else(|| Ok(String::new()))
		},
		|| async {
			#[cfg(desktop)]
			{
				session_refresh::refresh(&app, &verifier, revision).await
			}
			#[cfg(not(desktop))]
			{
				Ok(None)
			}
		},
	)
	.await?;
	// Logout or interactive login invalidates in-flight recovery, even when a
	// new login happens to export the same cookie header.
	let _mutation = AUTH_MUTATION.lock().map_err(|e| e.to_string())?;
	if AUTH_REVISION.load(Ordering::SeqCst) != revision
		|| read_cookie(&app)?.as_deref() != Some(saved.as_str())
	{
		return Err("Session recovery cancelled".into());
	}
	if let Some(cookie) = &recovered {
		if cookie != &saved {
			write_cookie(&app, cookie)?;
		}
	}
	Ok(recovered)
}

#[tauri::command]
pub async fn login(app: AppHandle) -> Result<Option<String>, String> {
	static LOGIN_ATTEMPT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
	let _attempt = LOGIN_ATTEMPT
		.try_lock()
		.map_err(|_| "Google sign-in is already open")?;
	let revision = {
		let _mutation = AUTH_MUTATION.lock().map_err(|e| e.to_string())?;
		let revision = AUTH_REVISION.fetch_add(1, Ordering::SeqCst) + 1;
		#[cfg(desktop)]
		session_refresh::cancel(&app);
		po_token::reset(&app);
		revision
	};
	let login_url = login_session::google_login_url()?;
	let verifier = session_verifier().await?;

	let builder = session_window(&app, "login", login_url)
		.title("Sign in with Google")
		.inner_size(800.0, 600.0);

	let window = builder.build().map_err(|e| e.to_string())?;

	let mut last_verification: Option<(String, std::time::Instant)> = None;

	loop {
		tokio::time::sleep(Duration::from_millis(1000)).await;

		if AUTH_REVISION.load(Ordering::SeqCst) != revision {
			break;
		}
		if app.get_webview_window("login").is_none() {
			break;
		}
		// Never interrupt the Google account picker, password or 2FA screens.
		if !window
			.url()
			.map(|url| login_session::is_youtube_page(&url))
			.unwrap_or(false)
		{
			continue;
		}

		let header = collect_login_cookies(&window)?;

		if !login_session::has_login_cookies(&header) {
			continue;
		}
		if last_verification.as_ref().is_some_and(|(previous, at)| {
			previous == &header && at.elapsed() < Duration::from_secs(5)
		}) {
			continue;
		}
		last_verification = Some((header.clone(), std::time::Instant::now()));
		match login_session::verify_login(&verifier, &header).await {
			Ok(true) => {}
			Ok(false) => continue,
			Err(_) => {
				// A temporary network failure must not close the login window.
				log::warn!("Could not verify Google sign-in; keeping the login window open");
				continue;
			}
		}
		// The user may have closed the window or returned to Google while verifying.
		if app.get_webview_window("login").is_none() {
			break;
		}
		if !window
			.url()
			.map(|url| login_session::is_youtube_page(&url))
			.unwrap_or(false)
		{
			continue;
		}
		{
			let _mutation = AUTH_MUTATION.lock().map_err(|e| e.to_string())?;
			if AUTH_REVISION.load(Ordering::SeqCst) != revision {
				break;
			}
			write_cookie(&app, &header)?;
		}

		if cfg!(target_os = "android") {
			// Android runs the whole app in a single activity, so closing
			// the login window is a no-op and finishing the activity would
			// quit the app. Instead, navigate the same webview back to the
			// app frontend.
			if let Ok(app_url) = Url::parse("http://tauri.localhost/") {
				let _ = window.navigate(app_url);
			}
		} else {
			let _ = window.close();
		}
		return Ok(Some(header));
	}

	#[cfg(desktop)]
	if AUTH_REVISION.load(Ordering::SeqCst) != revision {
		let _ = window.close();
	}

	Ok(None)
}
