//! Android's Media3 service. SABR remains the authenticated network producer;
//! compressed chunks cross IPC in bounded batches and native decoders play them.
use serde_json::Value;

#[tauri::command]
pub async fn native_audio_command(command: Value) -> Result<(), String> {
	#[cfg(target_os = "android")]
	{
		let data = serde_json::to_string(&command).map_err(|e| e.to_string())?;
		if data.len() > 8192 {
			return Err("Audio command too large".into());
		}
		send_audio_json("nativeAudioCommand", data).await
	}
	#[cfg(not(target_os = "android"))]
	{
		let _ = command;
		Err("Native audio is Android-only".into())
	}
}

#[tauri::command]
pub async fn native_audio_append(
	deck: i32,
	id: String,
	epoch: i32,
	data: String,
) -> Result<bool, String> {
	#[cfg(target_os = "android")]
	{
		use base64::Engine;
		use tauri_runtime_wry::wry::prelude::jni::objects::JValue;
		if !(0..=1).contains(&deck) || id.len() > 100 || data.len() > 90_000 {
			return Err("Invalid audio batch".into());
		}
		let bytes = base64::engine::general_purpose::STANDARD
			.decode(data)
			.map_err(|e| e.to_string())?;
		crate::android_activity::call(move |env, activity| {
			let id = env.new_string(id)?;
			let bytes = env.byte_array_from_slice(&bytes)?;
			env.call_method(
				activity,
				"nativeAudioAppend",
				"(ILjava/lang/String;I[B)Z",
				&[
					JValue::Int(deck),
					JValue::Object(id.as_ref()),
					JValue::Int(epoch),
					JValue::Object(bytes.as_ref()),
				],
			)?
			.z()
		})
		.await
	}
	#[cfg(not(target_os = "android"))]
	{
		let _ = (deck, id, epoch, data);
		Err("Native audio is Android-only".into())
	}
}

#[cfg(target_os = "android")]
pub async fn metadata(snapshot: &super::media_controls::MediaState) -> Result<(), String> {
	let data = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
	send_audio_json("updateAudioMetadata", data).await
}

#[cfg(target_os = "android")]
async fn send_audio_json(method: &'static str, data: String) -> Result<(), String> {
	use tauri_runtime_wry::wry::prelude::jni::objects::JValue;
	crate::android_activity::call(move |env, activity| {
		let data = env.new_string(data)?;
		env.call_method(
			activity,
			method,
			"(Ljava/lang/String;)V",
			&[JValue::Object(data.as_ref())],
		)?;
		Ok(())
	})
	.await
}
