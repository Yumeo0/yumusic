#[cfg(target_os = "android")]
mod android_activity;
mod discord;
mod downloads;
mod haptics;
mod http_client;
mod incoming_links;
mod login_session;
mod media_controls;
mod native_audio;
mod po_token;
mod proxy;
mod session_window;
mod sync_oauth;
mod youtube_session;

#[cfg(any(desktop, all(debug_assertions, feature = "mcp-bridge")))]
use tauri::Manager;

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
				use windows::core::Interface;
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
		.manage(downloads::DownloadStore::default())
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
			haptics::mobile_haptic,
			sync_oauth::begin_sync_oauth,
			sync_oauth::cancel_sync_oauth,
			native_audio::native_audio_command,
			native_audio::native_audio_append,
			po_token::mint_po_token,
			youtube_session::get_cookie,
			youtube_session::validate_session,
			youtube_session::login,
			youtube_session::logout,
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
