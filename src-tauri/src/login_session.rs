use serde_json::Value;
use tauri::Url;

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
pub fn page_is_signed_in(html: &str) -> bool {
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
	logged_in == Some(true)
}

pub async fn verify_login(client: &reqwest::Client, cookie: &str) -> Result<bool, reqwest::Error> {
	let response = client
		.get("https://music.youtube.com/")
		.header(reqwest::header::COOKIE, cookie)
		.header(reqwest::header::CACHE_CONTROL, "no-cache")
		.send()
		.await?
		.error_for_status()?;
	if !is_youtube_page(response.url()) {
		return Ok(false);
	}
	Ok(page_is_signed_in(&response.text().await?))
}

#[cfg(test)]
mod tests {
	use super::*;

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
