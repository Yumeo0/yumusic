#[tauri::command]
pub async fn mobile_haptic(kind: String) -> Result<(), String> {
	#[cfg(target_os = "android")]
	{
		use tauri_runtime_wry::wry::prelude::{dispatch, jni::objects::JValue};
		let feedback = match kind.as_str() {
			"tick" => 1,
			"confirm" => 2,
			_ => 0,
		};
		let (tx, rx) = tokio::sync::oneshot::channel();
		dispatch(move |env, activity, _| {
			let result =
				env.call_method(activity, "mobileHaptic", "(I)V", &[JValue::Int(feedback)]);
			let _ = tx.send(result.map(|_| ()).map_err(|e| e.to_string()));
		});
		rx.await.map_err(|e| e.to_string())?
	}
	#[cfg(not(target_os = "android"))]
	{
		let _ = kind;
		Ok(())
	}
}
