#[tauri::command]
pub async fn mobile_haptic(kind: String) -> Result<(), String> {
	#[cfg(target_os = "android")]
	{
		use tauri_runtime_wry::wry::prelude::jni::objects::JValue;
		let feedback = match kind.as_str() {
			"tick" => 1,
			"confirm" => 2,
			_ => 0,
		};
		crate::android_activity::call(move |env, activity| {
			env.call_method(activity, "mobileHaptic", "(I)V", &[JValue::Int(feedback)])?;
			Ok(())
		})
		.await
	}
	#[cfg(not(target_os = "android"))]
	{
		let _ = kind;
		Ok(())
	}
}
