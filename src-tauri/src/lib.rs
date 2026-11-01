mod discord;
mod downloads;
mod http_client;
mod incoming_links;
mod login_session;
mod media_controls;
mod native_audio;
mod po_token;
mod proxy;
mod sync_oauth;

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
		.map(dedup_cookie_header))
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
	read_cookie(&app)
}

#[tauri::command]
async fn logout(app: AppHandle) -> Result<bool, String> {
	po_token::reset(&app);
	let path = cookie_path(&app)?;
	if path.exists() {
		fs::remove_file(&path).map_err(|e| e.to_string())?;
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
		let window = app.get_webview_window("main").ok_or("Main window not found")?;
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
async fn validate_session(app: AppHandle) -> Result<Option<String>, String> {
	let Some(saved) = read_cookie(&app)? else {
		return Ok(None);
	};
	let verifier = session_verifier().await?;
	if login_session::verify_login(&verifier, &saved).await? {
		return Ok(Some(saved));
	}
	// A browser view may have rotated the cookies since cookie.json was saved.
	if let Some(window) = app.get_webview_window("main") {
		let current = collect_login_cookies(&window)?;
		if current != saved
			&& login_session::has_login_cookies(&current)
			&& login_session::verify_login(&verifier, &current).await?
		{
			// Do not resurrect a session if the user signed out during verification.
			if read_cookie(&app)?.as_deref() == Some(saved.as_str()) {
				write_cookie(&app, &current)?;
				return Ok(Some(current));
			}
		}
	}
	Ok(None)
}

#[tauri::command]
async fn login(app: AppHandle) -> Result<Option<String>, String> {
	po_token::reset(&app);
	let mut login_url = Url::parse("https://accounts.google.com/ServiceLogin?service=youtube")
		.map_err(|e| e.to_string())?;
	login_url
		.query_pairs_mut()
		.append_pair("continue", "https://music.youtube.com/");
	let verifier = session_verifier().await?;

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

	let mut last_verification: Option<(String, std::time::Instant)> = None;

	loop {
		tokio::time::sleep(Duration::from_millis(1000)).await;

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
		write_cookie(&app, &header)?;

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

	Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let context = tauri::generate_context!();
	let self_update_supported = cfg!(desktop)
		&& !(cfg!(target_os = "linux") && std::path::Path::new("/.flatpak-info").exists());
	// GTK uses the program name for Wayland's app_id. Set it before GTK
	// initializes so all windows resolve the matching desktop entry.
	#[cfg(target_os = "linux")]
	glib::set_prgname(Some(context.config().identifier.as_str()));

	let builder = tauri::Builder::default()
		.append_invoke_initialization_script(format!(
			"Object.defineProperty(window, '__YUMUSIC_SELF_UPDATE_SUPPORTED__', {{ value: {self_update_supported} }});"
		))
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
	let builder = if self_update_supported {
		builder
			.plugin(tauri_plugin_updater::Builder::new().build())
			.plugin(tauri_plugin_process::init())
	} else {
		builder
	};

	#[cfg(all(debug_assertions, feature = "mcp-bridge"))]
	let builder = builder.plugin(
		tauri_plugin_mcp_bridge::Builder::new()
			.bind_address("127.0.0.1")
			.build(),
	);

	builder
		.register_asynchronous_uri_scheme_protocol("proxy", proxy::handle)
		.manage(media_controls::MediaSession::default())
		.manage(sync_oauth::SyncOAuth::default())
		.setup(|app| {
			#[cfg(all(debug_assertions, feature = "mcp-bridge"))]
			app.add_capability(
				tauri::ipc::CapabilityBuilder::new("mcp-bridge-development")
					.window("main")
					.permission("mcp-bridge:default"),
			)?;
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
			incoming_links::take_pending_links,
			sync_oauth::begin_sync_oauth,
			sync_oauth::cancel_sync_oauth,
			native_audio::native_audio_command,
			native_audio::native_audio_append,
			po_token::mint_po_token,
			get_cookie,
			validate_session,
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
		.build(context)
		.expect("error while building tauri application")
		.run(|_app_handle, event| {
			if let tauri::RunEvent::Exit = event {
				discord::shutdown();
			}
		});
}
