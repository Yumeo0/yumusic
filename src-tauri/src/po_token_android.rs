use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::Value;
use tauri_runtime_wry::wry::prelude::{
	dispatch,
	jni::{
		errors::Error,
		objects::{JString, JValue},
	},
};
use tokio::sync::oneshot;

use super::PoToken;

/// A second Android WebView owns attestation; the Tauri playback view stays put.
pub async fn mint(binding: String) -> Result<PoToken, String> {
	static NEXT_ID: AtomicU64 = AtomicU64::new(1);
	let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).to_string();
	let request_id = id.clone();
	let (sender, receiver) = oneshot::channel();
	dispatch(move |env, activity, _| {
		let result = (|| {
			let id = env.new_string(request_id)?;
			let binding = env.new_string(binding)?;
			let script = env.new_string(include_str!("po_token_bridge.js"))?;
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
			Ok::<(), Error>(())
		})();
		let _ = sender.send(result.map_err(|e| e.to_string()));
	});
	receiver.await.map_err(|e| e.to_string())??;
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
	if let Some(error) = value.get("error").and_then(Value::as_str) {
		return Err(error.to_owned());
	}
	let token = value["token"]
		.as_str()
		.filter(|token| !token.is_empty())
		.ok_or("YouTube did not return a PO token")?
		.to_owned();
	let context = value
		.get("context")
		.filter(|context| context["client"]["visitorData"].is_string())
		.ok_or("YouTube did not return a visitor context")?
		.clone();
	Ok(PoToken {
		token,
		context,
		account_index: value["accountIndex"].as_u64().unwrap_or(0),
		cookie: super::super::dedup_cookie_header(value["cookie"].as_str().unwrap_or_default()),
	})
}

async fn poll(id: String) -> Result<Option<String>, String> {
	let (sender, receiver) = oneshot::channel();
	dispatch(move |env, activity, _| {
		let result = (|| {
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
			Ok::<_, Error>(Some(payload))
		})();
		let _ = sender.send(result.map_err(|e| e.to_string()));
	});
	receiver.await.map_err(|e| e.to_string())?
}

pub fn reset() {
	dispatch(|env, activity, _| {
		if let Err(error) = env.call_method(activity, "resetPoToken", "()V", &[]) {
			log::warn!("Could not reset Android PO minter: {error}");
		}
	});
}
