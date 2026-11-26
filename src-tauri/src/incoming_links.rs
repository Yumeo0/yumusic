//! Retrieve Android view/share intents after the frontend is ready.
#[tauri::command]
pub async fn take_pending_links() -> Result<Vec<String>, String> {
	#[cfg(target_os = "android")]
	{
		use tauri_runtime_wry::wry::prelude::jni::objects::JString;
		let json: String = crate::android_activity::call(|env, activity| {
			let value = env
				.call_method(activity, "takePendingLinks", "()Ljava/lang/String;", &[])?
				.l()?;
			Ok(env.get_string(&JString::from(value))?.into())
		})
		.await?;
		serde_json::from_str(&json).map_err(|e| e.to_string())
	}
	#[cfg(not(target_os = "android"))]
	Ok(Vec::new())
}
