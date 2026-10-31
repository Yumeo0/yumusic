/// YouTube can reset proxied HTTP/2 requests with PROTOCOL_ERROR. Use HTTP/1.1
/// for both the proxy and login verifier on every platform. Android also needs
/// its trust roots supplied explicitly to avoid an uninitialized JVM verifier.
pub async fn builder() -> Result<reqwest::ClientBuilder, String> {
	let builder = reqwest::Client::builder().http1_only();
	#[cfg(target_os = "android")]
	{
		use tauri_runtime_wry::wry::prelude::{
			dispatch,
			jni::{
				errors::Error,
				objects::{JByteArray, JObjectArray},
			},
		};
		static ROOTS: tokio::sync::OnceCell<Vec<reqwest::Certificate>> =
			tokio::sync::OnceCell::const_new();
		let roots = ROOTS
			.get_or_try_init(|| async {
				let (sender, receiver) = tokio::sync::oneshot::channel();
				dispatch(move |env, activity, _| {
					let result = (|| {
						let array = env
							.call_method(activity, "trustedRootCertificates", "()[[B", &[])?
							.l()?;
						let array = JObjectArray::from(array);
						let mut roots = Vec::new();
						for index in 0..env.get_array_length(&array)? {
							let cert = env.get_object_array_element(&array, index)?;
							let cert = JByteArray::from(cert);
							roots.push(env.convert_byte_array(&cert)?);
							env.delete_local_ref(cert)?;
						}
						Ok::<_, Error>(roots)
					})();
					let _ = sender.send(result.map_err(|e| e.to_string()));
				});
				let certs = receiver.await.map_err(|e| e.to_string())??;
				if certs.is_empty() {
					return Err("Android returned no trusted certificates".to_string());
				}
				certs
					.iter()
					.map(|cert| reqwest::Certificate::from_der(cert).map_err(|e| e.to_string()))
					.collect::<Result<Vec<_>, _>>()
			})
			.await?;
		return Ok(builder.tls_certs_only(roots.iter().cloned()));
	}
	#[cfg(not(target_os = "android"))]
	Ok(builder)
}
