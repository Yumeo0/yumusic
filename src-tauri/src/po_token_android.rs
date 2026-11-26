use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri_runtime_wry::wry::prelude::{
	dispatch,
	jni::objects::{JString, JValue},
};

use super::{PoToken, MINT_SCRIPT};

/// A second Android WebView owns attestation; the Tauri playback view stays put.
pub async fn mint(binding: String) -> Result<PoToken, String> {
	static NEXT_ID: AtomicU64 = AtomicU64::new(1);
	let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
	let request_id = id.clone();
	crate::android_activity::call(move |env, activity| {
		let id = env.new_string(request_id)?;
		let binding = env.new_string(binding)?;
		let script = env.new_string(MINT_SCRIPT)?;
		env.call_method(
			activity,
			"beginPoToken",
			"(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
			&[
				JValue::Object(id.as_ref()),
				JValue::Object(binding.as_ref()),
				JValue::Object(script.as_ref()),
			],
		)?;
		Ok(())
	})
	.await?;
	let value = tokio::time::timeout(Duration::from_secs(40), async {
		loop {
			if let Some(payload) = poll(id.clone()).await? {
				break serde_json::from_str::<Value>(&payload).map_err(|e| e.to_string());
			}
			tokio::time::sleep(Duration::from_millis(250)).await;
		}
	})
	.await
	.map_err(|_| "Android YouTube PO token minting timed out".to_string())??;
	PoToken::from_response(value)
}

async fn poll(id: String) -> Result<Option<String>, String> {
	crate::android_activity::call(move |env, activity| {
		let id = env.new_string(id)?;
		let value = env
			.call_method(
				activity,
				"pollPoToken",
				"(Ljava/lang/String;)Ljava/lang/String;",
				&[JValue::Object(id.as_ref())],
			)?
			.l()?;
		if value.is_null() {
			return Ok(None);
		}
		let value = JString::from(value);
		let payload: String = env.get_string(&value)?.into();
		Ok(Some(payload))
	})
	.await
}

pub fn reset() {
	dispatch(|env, activity, _| {
		if let Err(error) = env.call_method(activity, "resetPoToken", "()V", &[]) {
			let _ = env.exception_clear();
			log::warn!("Could not reset Android PO minter: {error}");
		}
	});
}
