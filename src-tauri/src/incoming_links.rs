//! Retrieve Android view/share intents after the frontend is ready.
#[tauri::command]
pub async fn take_pending_links() -> Result<Vec<String>, String> {
	#[cfg(target_os = "android")]
	{
		use tauri_runtime_wry::wry::prelude::{dispatch, jni::objects::JString};
		let (tx, rx) = tokio::sync::oneshot::channel();
		dispatch(move |env, activity, _| {
			let result = (|| {
				let value = env
					.call_method(activity, "takePendingLinks", "()Ljava/lang/String;", &[])?
					.l()?;
				let json: String = env.get_string(&JString::from(value))?.into();
				Ok::<String, tauri_runtime_wry::wry::prelude::jni::errors::Error>(json)
			})();
			let _ = tx.send(result.map_err(|e| e.to_string()));
		});
		let json = rx.await.map_err(|e| e.to_string())??;
		serde_json::from_str(&json).map_err(|e| e.to_string())
	}
	#[cfg(not(target_os = "android"))]
	Ok(Vec::new())
}
