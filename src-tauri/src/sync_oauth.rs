//! External-browser OAuth with a one-use loopback callback (RFC 8252).
//! Supabase PKCE verifies the code in the original app. No tokens enter URLs.
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Default)]
pub struct SyncOAuth(Mutex<Option<tokio::task::AbortHandle>>);

#[tauri::command]
pub fn cancel_sync_oauth(state: tauri::State<'_, SyncOAuth>) -> Result<(), String> {
    if let Some(task) = state.0.lock().map_err(|_| "OAuth lock failed")?.take() {
        task.abort();
    }
    Ok(())
}

fn callback(query: &str, path: &str) -> Option<serde_json::Value> {
    let url = tauri::Url::parse(&format!("http://127.0.0.1:43827{query}")).ok()?;
    if url.path() != path {
        return None;
    }
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    if let Some(code) = pairs
        .get("code")
        .filter(|code| !code.is_empty() && code.len() <= 2048)
    {
        return Some(serde_json::json!({"code": code}));
    }
    pairs
        .get("error")
        .map(|_| serde_json::json!({"error": "Google sign-in was denied. Please try again."}))
}

#[tauri::command]
pub async fn begin_sync_oauth(app: AppHandle, nonce: String) -> Result<String, String> {
    if nonce.len() != 64 || !nonce.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid OAuth nonce".into());
    }
    cancel_sync_oauth(app.state::<SyncOAuth>())?;
    let listener = TcpListener::bind("127.0.0.1:43827").await.map_err(|_| {
        "The sign-in callback port is busy. Close other YuMusic windows and try again."
    })?;
    let path = format!("/sync/callback/{nonce}");
    let redirect = format!("http://127.0.0.1:43827{path}");
    let event_app = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let receive = async {
            loop {
                let (mut stream, _) = listener.accept().await.ok()?;
                let mut request = Vec::new();
                // Limit both bytes and time: an unrelated local connection
                // must not hold the callback port or inject a foreign path.
                let read = async {
                    let mut chunk = [0u8; 1024];
                    while request.len() < 8192 {
                        let count = stream.read(&mut chunk).await.ok()?;
                        if count == 0 {
                            return None;
                        }
                        request.extend_from_slice(&chunk[..count]);
                        if request.windows(4).any(|w| w == b"\r\n\r\n") {
                            return Some(());
                        }
                    }
                    None
                };
                if !matches!(
                    tokio::time::timeout(Duration::from_secs(5), read).await,
                    Ok(Some(()))
                ) {
                    continue;
                }
                let text = String::from_utf8_lossy(&request);
                let mut words = text.lines().next().unwrap_or_default().split_whitespace();
                let method = words.next();
                let target = words.next().unwrap_or_default();
                let host_ok = text
                    .lines()
                    .any(|line| line.eq_ignore_ascii_case("host: 127.0.0.1:43827"));
                let response = if method == Some("GET") && host_ok {
                    callback(target, &path)
                } else {
                    None
                };
                let (status, body) = if response.is_some() {
                    ("200 OK", "<!doctype html><meta name=viewport content='width=device-width'><title>YuMusic</title><p>You can close this tab and return to YuMusic.</p>")
                } else {
                    ("404 Not Found", "Not found")
                };
                let headers = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    stream.write_all(headers.as_bytes()),
                )
                .await;
                if response.is_some() {
                    return response;
                }
            }
        };
        let mut result = match tokio::time::timeout(Duration::from_secs(300), receive).await {
            Ok(Some(value)) => value,
            _ => serde_json::json!({"error": "Google sign-in timed out. Please try again."}),
        };
        result["nonce"] = nonce.into();
        let _ = event_app.emit_to("main", "sync-oauth-result", result);
    });
    let abort = task.inner().abort_handle();
    app.state::<SyncOAuth>()
        .0
        .lock()
        .map_err(|_| "OAuth lock failed")?
        .replace(abort);
    Ok(redirect)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_requires_the_original_path_and_a_code() {
        assert!(callback("/sync/callback/wrong?code=abc", "/sync/callback/right").is_none());
        assert!(callback("/sync/callback/right?code=", "/sync/callback/right").is_none());
        assert_eq!(
            callback("/sync/callback/right?code=abc", "/sync/callback/right").unwrap()["code"],
            "abc"
        );
        assert!(callback("/sync/callback/right#error=denied", "/sync/callback/right").is_none());
        assert!(callback(
            "/sync/callback/right?error=access_denied",
            "/sync/callback/right"
        )
        .unwrap()
        .get("error")
        .is_some());
    }
}
