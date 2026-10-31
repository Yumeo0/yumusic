//! Android's Media3 service. SABR remains the authenticated network producer;
//! compressed chunks cross IPC in bounded batches and native decoders play them.
use serde_json::Value;

#[tauri::command]
pub async fn native_audio_command(command: Value) -> Result<(), String> {
	#[cfg(target_os = "android")]
	{
		use tauri_runtime_wry::wry::prelude::{dispatch, jni::objects::JValue};
		let data = serde_json::to_string(&command).map_err(|e| e.to_string())?;
		if data.len() > 8192 {
			return Err("Audio command too large".into());
		}
		let (tx, rx) = tokio::sync::oneshot::channel();
		dispatch(move |env, activity, _| {
			let result = (|| {
				let data = env.new_string(data)?;
				env.call_method(
					activity,
					"nativeAudioCommand",
					"(Ljava/lang/String;)V",
					&[JValue::Object(data.as_ref())],
				)?;
				Ok::<(), tauri_runtime_wry::wry::prelude::jni::errors::Error>(())
			})();
			let _ = tx.send(result.map_err(|e| e.to_string()));
		});
		rx.await.map_err(|e| e.to_string())?
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
		use tauri_runtime_wry::wry::prelude::{dispatch, jni::objects::JValue};
		if !(0..=1).contains(&deck) || id.len() > 100 || data.len() > 90_000 {
			return Err("Invalid audio batch".into());
		}
		let bytes = base64::engine::general_purpose::STANDARD
			.decode(data)
			.map_err(|e| e.to_string())?;
		let (tx, rx) = tokio::sync::oneshot::channel();
		dispatch(move |env, activity, _| {
			let result = (|| {
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
			})();
			let _ = tx.send(result.map_err(|e| e.to_string()));
		});
		rx.await.map_err(|e| e.to_string())?
	}
	#[cfg(not(target_os = "android"))]
	{
		let _ = (deck, id, epoch, data);
		Err("Native audio is Android-only".into())
	}
}

#[cfg(target_os = "android")]
pub async fn metadata(snapshot: &super::media_controls::MediaState) -> Result<(), String> {
	use tauri_runtime_wry::wry::prelude::{dispatch, jni::objects::JValue};
	let data = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
	let (tx, rx) = tokio::sync::oneshot::channel();
	dispatch(move |env, activity, _| {
		let result = (|| {
			let data = env.new_string(data)?;
			env.call_method(
				activity,
				"updateAudioMetadata",
				"(Ljava/lang/String;)V",
				&[JValue::Object(data.as_ref())],
			)?;
			Ok::<(), tauri_runtime_wry::wry::prelude::jni::errors::Error>(())
		})();
		let _ = tx.send(result.map_err(|e| e.to_string()));
	});
	rx.await.map_err(|e| e.to_string())?
}
