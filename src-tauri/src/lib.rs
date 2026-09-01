mod discord;
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
		.map(String::from))
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

	let window = WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(login_url))
		.title("Sign in with Google")
		.inner_size(800.0, 600.0)
		.build()
		.map_err(|e| e.to_string())?;

	let youtube_url = Url::parse("https://www.youtube.com/").map_err(|e| e.to_string())?;

	loop {
		tokio::time::sleep(Duration::from_millis(1000)).await;

		if app.get_webview_window("login").is_none() {
			break;
		}

		let cookies = match window.cookies_for_url(youtube_url.clone()) {
			Ok(cookies) => cookies,
			Err(_) => continue,
		};

		let header = cookies
			.iter()
			.map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
			.collect::<Vec<_>>()
			.join("; ");

		if header.contains("__Secure-3PSID") {
			let path = cookie_path(&app)?;
			let data =
				serde_json::to_string(&serde_json::json!({ "cookie": header.clone() }))
					.map_err(|e| e.to_string())?;
			fs::write(&path, data).map_err(|e| e.to_string())?;
			let _ = window.close();
			return Ok(Some(header));
		}
	}

	Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	tauri::Builder::default()
		.register_asynchronous_uri_scheme_protocol("proxy", proxy::handle)
		.setup(|app| {
			if cfg!(debug_assertions) {
				app.handle().plugin(
					tauri_plugin_log::Builder::default()
						.level(log::LevelFilter::Info)
						.build(),
				)?;
			}
			Ok(())
		})
		.invoke_handler(tauri::generate_handler![
			get_cookie,
			login,
			logout,
			discord::set_discord_activity,
			discord::clear_discord_activity
		])
		.build(tauri::generate_context!())
		.expect("error while building tauri application")
		.run(|_app_handle, event| {
			if let tauri::RunEvent::Exit = event {
				discord::shutdown();
			}
		});
}
