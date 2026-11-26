use tauri::{AppHandle, Url, WebviewUrl, WebviewWindowBuilder};

pub fn session_window<'a, R: tauri::Runtime>(
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
