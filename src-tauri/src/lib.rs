mod discord;
mod downloads;
mod media_controls;
mod proxy;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

fn cookie_path(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
	fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
	Ok(dir.join("cookie.json"))
}

/// Joins cookies into a header value, keeping only the first occurrence of
/// each name. Google rejects headers that list a cookie twice with a
/// redirect to accounts.google.com/CookieMismatch; older YuMusic versions
/// stored such duplicated headers, so this is applied on read as well.
fn dedup_cookie_header(header: &str) -> String {
	let mut seen = std::collections::HashSet::new();
	header
		.split("; ")
		.filter(|pair| {
			let name = pair.split('=').next().unwrap_or_default();
			!name.is_empty() && seen.insert(name.to_string())
		})
		.collect::<Vec<_>>()
		.join("; ")
}

#[tauri::command]
fn get_cookie(app: AppHandle) -> Result<Option<String>, String> {
	let path = cookie_path(&app)?;
	if !path.exists() {
		return Ok(None);
	}
	let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
	let value: Value = serde_json::from_str(&data).map_err(|e| e.to_string())?;
	Ok(value
		.get("cookie")
		.and_then(|cookie| cookie.as_str())
		.map(dedup_cookie_header))
}

#[tauri::command]
fn logout(app: AppHandle) -> Result<bool, String> {
	let path = cookie_path(&app)?;
	if path.exists() {
		fs::remove_file(&path).map_err(|e| e.to_string())?;
	}
	Ok(true)
}

#[tauri::command]
async fn login(app: AppHandle) -> Result<Option<String>, String> {
	let login_url = Url::parse("https://accounts.google.com/ServiceLogin?service=youtube")
		.map_err(|e| e.to_string())?;

	let mut builder = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(login_url))
		.title("Sign in with Google")
		.inner_size(800.0, 600.0);

	// WebView2 shares one user data folder across all webviews and refuses to
	// create a second environment for it when the browser arguments differ
	// (HRESULT 0x8007139F), so the login webview has to reuse the main
	// window's `additionalBrowserArgs` exactly.
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

	// Check both the desktop and mobile YouTube origins: after signing in, the
	// webview can land on m.youtube.com, whose cookies would not be returned
	// when querying www.youtube.com on some platforms (e.g. Android). The
	// music origin is queried too in case the session is scoped to it.
	let youtube_urls = [
		Url::parse("https://www.youtube.com/").map_err(|e| e.to_string())?,
		Url::parse("https://m.youtube.com/").map_err(|e| e.to_string())?,
		Url::parse("https://music.youtube.com/").map_err(|e| e.to_string())?,
	];

	// The flow can stall on accounts.google.com, which only sets the
	// third-party cookie variants. Bounce the webview to YouTube once (after
	// the account cookies appear) so the first-party session cookies are
	// issued there.
	let mut nudged_to_youtube = false;

	loop {
		tokio::time::sleep(Duration::from_millis(1000)).await;

		if app.get_webview_window("login").is_none() {
			break;
		}

		// Both origins carry the same session cookies; deduplicate by name.
		// A Cookie header that lists every cookie twice gets rejected by
		// Google with a redirect to accounts.google.com/CookieMismatch,
		// which then looks like a signed-out session everywhere.
		let mut seen = std::collections::HashSet::new();
		let mut parts: Vec<String> = Vec::new();
		for url in &youtube_urls {
			if let Ok(cookies) = window.cookies_for_url(url.clone()) {
				for cookie in cookies {
					if seen.insert(cookie.name().to_string()) {
						parts.push(format!("{}={}", cookie.name(), cookie.value()));
					}
				}
			}
		}
		let header = parts.join("; ");

		// `__Secure-3PSID` alone is not proof of a usable session: Google also
		// sets the third-party variant while the flow is still on
		// accounts.google.com. The API's `SAPISIDHASH` authorization needs a
		// first-party secret, so wait until `SAPISID`/`__Secure-1PAPISID` shows
		// up too (they are issued once the webview lands back on youtube.com).
		// Capturing earlier stored a session the API treats as signed out — no
		// profile, no home feed and an empty library.
		let has_first_party_secret =
			header.contains("SAPISID=") || header.contains("__Secure-1PAPISID=");

		if header.contains("__Secure-3PSID") && has_first_party_secret {
			let path = cookie_path(&app)?;
			let data =
				serde_json::to_string(&serde_json::json!({ "cookie": header.clone() }))
					.map_err(|e| e.to_string())?;
			fs::write(&path, data).map_err(|e| e.to_string())?;

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

		if header.contains("__Secure-3PSID") && !nudged_to_youtube {
			nudged_to_youtube = true;
			if let Some(home) = youtube_urls.first() {
				let _ = window.navigate(home.clone());
			}
		}
	}

	Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let builder = tauri::Builder::default()
		.runtime(tauri_runtime_wry::Wry::default())
		.on_window_event(|_window, _event| {
			#[cfg(target_os = "windows")]
			if let tauri::WindowEvent::Focused(focused) = _event {
				use tauri_runtime_wry::WebviewWryExt;
				use webview2_com::Microsoft::Web::WebView2::Win32::{
					ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL,
				};
				use windows_core::Interface;
				if let Some(webview) = _window.app_handle().get_webview_window(_window.label()) {
					let level = if *focused { 0 } else { 1 };
					// Release browser caches while inactive without suspending music,
					// timers, downloads, or network requests. Restore normal on focus.
					let _ = webview.with_wry_webview(move |view| unsafe {
						if let Ok(core) = view.controller().CoreWebView2() {
							if let Ok(core) = core.cast::<ICoreWebView2_19>() {
								let _ = core.SetMemoryUsageTargetLevel(
									COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL(level),
								);
							}
						}
					});
				}
			}
		})
		.plugin(tauri_plugin_opener::init())
		.plugin(tauri_plugin_os::init());

	// Self-updating is desktop-only (the plugins don't target Android/iOS).
	#[cfg(desktop)]
	let builder = builder
		.plugin(tauri_plugin_updater::Builder::new().build())
		.plugin(tauri_plugin_process::init());

	builder
		.register_asynchronous_uri_scheme_protocol("proxy", proxy::handle)
		.manage(media_controls::MediaSession::default())
		.setup(|app| {
			if cfg!(debug_assertions) {
				app.handle().plugin(
					tauri_plugin_log::Builder::default()
						.level(log::LevelFilter::Info)
						.build(),
				)?;
			}
			// The native media session identifies the app by AUMID; the NSIS
			// shortcut carries the bundle identifier, so setting it on the
			// process is what makes Windows show "YuMusic" with its icon
			// instead of "Unknown App".
			#[cfg(target_os = "windows")]
			{
				use windows::core::HSTRING;
				use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
				let identifier = app.config().identifier.clone();
				unsafe {
					if let Err(error) =
						SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(identifier))
					{
						eprintln!("[media] AUMID not set: {error}");
					}
				}
			}
			// Native media session: the OS gets the app's real name and icon,
			// and the hardware media keys reach the frontend. Windows needs
			// the main window's handle.
			#[cfg(desktop)]
			{
				#[cfg(target_os = "windows")]
				let hwnd = app
					.get_webview_window("main")
					.and_then(|window| window.hwnd().ok())
					.map(|hwnd| hwnd.0 as u64);
				#[cfg(not(target_os = "windows"))]
				let hwnd: Option<u64> = None;
				app.state::<media_controls::MediaSession>()
					.init(app.handle(), hwnd);
			}
			Ok(())
		})
		.invoke_handler(tauri::generate_handler![
			get_cookie,
			login,
			logout,
			discord::set_discord_activity,
			discord::clear_discord_activity,
			downloads::download_begin,
			downloads::download_append,
			downloads::download_finish,
			downloads::download_abort,
			downloads::downloads_list,
			downloads::downloads_remove,
			media_controls::update_media_session
		])
		.build(tauri::generate_context!())
		.expect("error while building tauri application")
		.run(|_app_handle, event| {
			if let tauri::RunEvent::Exit = event {
				discord::shutdown();
			}
		});
}
