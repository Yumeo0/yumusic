use tauri_runtime_wry::wry::prelude::{
	dispatch,
	jni::{errors::Result as JniResult, objects::JObject, JNIEnv},
};

pub async fn call<T: Send + 'static>(
	operation: impl FnOnce(&mut JNIEnv, &JObject) -> JniResult<T> + Send + 'static,
) -> Result<T, String> {
	let (sender, receiver) = tokio::sync::oneshot::channel();
	dispatch(move |env, activity, _| {
		let result = operation(env, activity).map_err(|error| {
			// Wry shares this JNI thread with the WebView and future activity calls.
			let _ = env.exception_clear();
			error.to_string()
		});
		let _ = sender.send(result);
	});
	receiver.await.map_err(|error| error.to_string())?
}
