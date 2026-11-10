use serde_json::Value;
use tauri::Url;

pub fn google_login_url() -> Result<Url, String> {
	let mut url = Url::parse("https://accounts.google.com/ServiceLogin?service=youtube")
		.map_err(|e| e.to_string())?;
	url.query_pairs_mut()
		.append_pair("continue", "https://music.youtube.com/");
	Ok(url)
}

/// Try browser renewal when neither cookie snapshot can authenticate.
/// A Google browser session can outlive the exported YouTube cookies.
pub async fn recover_login<V, VF, C, R, RF>(
	saved: &str,
	mut verify: V,
	current: C,
	refresh: R,
) -> Result<Option<String>, String>
where
	V: FnMut(String) -> VF,
	VF: std::future::Future<Output = Result<bool, String>>,
	C: FnOnce() -> Result<String, String>,
	R: FnOnce() -> RF,
	RF: std::future::Future<Output = Result<Option<String>, String>>,
{
	let saved_result = verify(saved.to_owned()).await;
	if saved_result == Ok(true) {
		return Ok(Some(saved.to_owned()));
	}
	let mut verification_error = saved_result.err();
	let current = current()?;
	if current != saved && has_login_cookies(&current) {
		match verify(current.clone()).await {
			Ok(true) => return Ok(Some(current)),
			Ok(false) => {}
			Err(error) => verification_error = Some(error),
		}
	}
	match refresh().await? {
		Some(cookie) => Ok(Some(cookie)),
		None => match verification_error {
			Some(error) => Err(error),
			None => Ok(None),
		},
	}
}

pub fn is_youtube_page(url: &Url) -> bool {
	url.scheme() == "https"
		&& matches!(
			url.host_str(),
			Some("www.youtube.com" | "m.youtube.com" | "music.youtube.com")
		)
}

pub fn has_login_cookies(header: &str) -> bool {
	let names: Vec<&str> = header
		.split(';')
		.filter_map(|pair| {
			let (name, value) = pair.trim().split_once('=')?;
			(!value.is_empty()).then_some(name)
		})
		.collect();
	let has_session = ["SID", "__Secure-1PSID", "__Secure-3PSID"]
		.iter()
		.any(|name| names.contains(name));
	let has_secret = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]
		.iter()
		.any(|name| names.contains(name));
	has_session && has_secret
}

/// Read the server's sign-in verdict, rather than trusting cookie existence.
#[cfg(test)]
pub fn page_is_signed_in(html: &str) -> bool {
	page_login_status(html) == Some(true)
}

/// Missing or unrecognized config is inconclusive, not evidence of logout.
fn page_login_status(html: &str) -> Option<bool> {
	let mut logged_in = None;
	for fragment in html.split("ytcfg.set").skip(1) {
		let Some(json) = fragment.trim_start().strip_prefix('(') else {
			continue;
		};
		if let Some(Ok(config)) = serde_json::Deserializer::from_str(json)
			.into_iter::<Value>()
			.next()
		{
			if let Some(value) = config.get("LOGGED_IN").and_then(Value::as_bool) {
				logged_in = Some(value);
			}
		}
	}
	logged_in
}

pub async fn verify_login(client: &reqwest::Client, cookie: &str) -> Result<bool, String> {
	let response = client
		.get("https://music.youtube.com/")
		.header(reqwest::header::COOKIE, cookie)
		.header(reqwest::header::CACHE_CONTROL, "no-cache")
		.send()
		.await
		.map_err(|e| e.to_string())?
		.error_for_status()
		.map_err(|e| e.to_string())?;
	if !is_youtube_page(response.url()) {
		return Err("Session check redirected away from YouTube".to_string());
	}
	let html = response.text().await.map_err(|e| e.to_string())?;
	page_login_status(&html)
		.ok_or_else(|| "YouTube returned no explicit sign-in status".to_string())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn valid_saved_session_does_not_open_a_browser() {
		let result = tauri::async_runtime::block_on(recover_login(
			"saved",
			|_| async { Ok(true) },
			|| panic!("No browser cookie lookup needed"),
			|| async { panic!("No browser refresh needed") },
		));
		assert_eq!(result, Ok(Some("saved".into())));
	}

	#[test]
	fn already_rotated_browser_cookies_do_not_need_navigation() {
		let current = "SID=current; SAPISID=secret";
		let result = tauri::async_runtime::block_on(recover_login(
			"saved",
			|cookie| async move { Ok(cookie == current) },
			|| Ok(current.into()),
			|| async { panic!("No browser refresh needed") },
		));
		assert_eq!(result, Ok(Some(current.into())));
	}

	#[test]
	fn expired_snapshots_renew_through_the_google_browser_session() {
		for current in ["saved", "SID=stale; SAPISID=stale", ""] {
			let result = tauri::async_runtime::block_on(recover_login(
				"saved",
				|_| async { Ok(false) },
				|| Ok(current.into()),
				|| async { Ok(Some("SID=renewed; SAPISID=renewed".into())) },
			));
			assert_eq!(result, Ok(Some("SID=renewed; SAPISID=renewed".into())));
		}
	}

	#[test]
	fn browser_recovery_failure_is_inconclusive_not_logout() {
		let result = tauri::async_runtime::block_on(recover_login(
			"saved",
			|_| async { Ok(false) },
			|| Ok(String::new()),
			|| async { Err("Offline during renewal".into()) },
		));
		assert_eq!(result, Err("Offline during renewal".into()));
	}

	#[test]
	fn inconclusive_cookie_check_can_still_recover_in_the_browser() {
		let result = tauri::async_runtime::block_on(recover_login(
			"saved",
			|_| async { Err("Session check redirected away from YouTube".into()) },
			|| Ok(String::new()),
			|| async { Ok(Some("SID=renewed; SAPISID=renewed".into())) },
		));
		assert_eq!(result, Ok(Some("SID=renewed; SAPISID=renewed".into())));
	}

	#[test]
	fn inconclusive_cookie_checks_cannot_become_logout() {
		let result = tauri::async_runtime::block_on(recover_login(
			"saved",
			|_| async { Err("Offline".into()) },
			|| Ok(String::new()),
			|| async { Ok(None) },
		));
		assert_eq!(result, Err("Offline".into()));
	}

	#[test]
	fn failed_browser_sign_in_honors_expired_session() {
		let result = tauri::async_runtime::block_on(recover_login(
			"saved",
			|_| async { Ok(false) },
			|| Ok(String::new()),
			|| async { Ok(None) },
		));
		assert_eq!(result, Ok(None));
	}

	#[test]
	fn timestamp_and_empty_cookies_do_not_prove_login() {
		assert!(!has_login_cookies(
			"__Secure-3PSIDTS=timestamp; SAPISID=old"
		));
		assert!(!has_login_cookies("__Secure-3PSID=; SAPISID=old"));
		assert!(!has_login_cookies("__Secure-3PSID=old; SAPISID="));
		assert!(!has_login_cookies("__Secure-3PSID=old; NOT_SAPISID=old"));
		assert!(has_login_cookies("__Secure-3PSID=session; SAPISID=secret"));
		assert!(has_login_cookies("SID=session; __Secure-3PAPISID=secret"));
	}

	#[test]
	fn stale_cookies_cannot_override_the_servers_signed_out_verdict() {
		assert!(has_login_cookies("__Secure-3PSID=stale; SAPISID=stale"));
		assert!(!page_is_signed_in(
			r#"<script>ytcfg.set({"LOGGED_IN":false});</script>"#
		));
		assert!(!page_is_signed_in(
			"<html>Google sign-in or consent page</html>"
		));
		assert!(!page_is_signed_in(r#"ytcfg.set({"LOGGED_IN":"true"});"#));
	}

	#[test]
	fn reads_the_latest_explicit_server_verdict() {
		assert!(page_is_signed_in(
			r#"ytcfg.set({"LOGGED_IN":true}); otherJavascript();"#
		));
		assert!(page_is_signed_in(r#"ytcfg.set ( {"LOGGED_IN": true} );"#));
		assert!(page_is_signed_in(
			r#"ytcfg.set({"OTHER":1}); ytcfg.set({"LOGGED_IN":true});"#
		));
		assert!(!page_is_signed_in(
			r#"ytcfg.set({"LOGGED_IN":true}); ytcfg.set({"LOGGED_IN":false});"#
		));
	}

	#[test]
	fn unknown_pages_are_not_signed_out_verdicts() {
		assert_eq!(page_login_status("<html>Consent or challenge</html>"), None);
		assert_eq!(
			page_login_status(r#"ytcfg.set({"LOGGED_IN":"true"});"#),
			None
		);
		assert_eq!(
			page_login_status(r#"ytcfg.set({"LOGGED_IN":false});"#),
			Some(false)
		);
		assert_eq!(
			page_login_status(r#"ytcfg.set({"LOGGED_IN":true});"#),
			Some(true)
		);
	}

	#[test]
	fn google_sign_in_pages_are_never_login_completion() {
		for url in [
			"https://accounts.google.com/ServiceLogin",
			"https://youtube.com.example.com/",
			"http://music.youtube.com/",
		] {
			assert!(!is_youtube_page(&Url::parse(url).unwrap()));
		}
		assert!(is_youtube_page(
			&Url::parse("https://music.youtube.com/").unwrap()
		));
	}
}
