#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(not(target_os = "android"))]
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(not(target_os = "android"))]
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "android"))]
static DISCORD: Mutex<Option<DiscordIpcClient>> = Mutex::new(None);

const APPLICATION_ID: &str = "1544382362924613854";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackPresence {
	pub title: String,
	pub artist: String,
	pub album: Option<String>,
	pub cover_url: Option<String>,
	pub artist_avatar_url: Option<String>,
	pub song_url: String,
	pub artist_url: Option<String>,
	pub album_url: Option<String>,
	pub playing: bool,
	pub elapsed_secs: f64,
	pub duration_secs: f64,
}

/// Discord caps presence fields (byte length); keep text within them.
#[cfg(not(target_os = "android"))]
fn clamp(text: &str, max: usize) -> String {
	if text.len() <= max {
		return text.to_owned();
	}
	let mut end = max;
	while !text.is_char_boundary(end) {
		end -= 1;
	}
	text[..end].to_owned()
}

#[cfg(not(target_os = "android"))]
fn now_ms() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|d| d.as_millis() as i64)
		.unwrap_or(0)
}

#[cfg(not(target_os = "android"))]
fn set_desktop_activity(track: TrackPresence) -> Result<(), String> {
	let mut guard = DISCORD.lock().map_err(|_| "discord state poisoned")?;
	let client = match guard.as_mut() {
		Some(client) => client,
		None => {
			let mut client = DiscordIpcClient::new(APPLICATION_ID);
			client.connect().map_err(|e| e.to_string())?;
			guard.insert(client)
		}
	};

	let artist_name = clamp(&track.artist, 128);
	let mut assets = activity::Assets::new();
	if let Some(cover) = &track.cover_url {
		let large_text = if track.playing {
			clamp(track.album.as_deref().unwrap_or(&track.title), 128)
		} else {
			"\u{23F8}\u{FE0E}".to_owned()
		};
		assets = assets.large_image(cover.clone()).large_text(large_text);
		if let Some(album_url) = &track.album_url {
			assets = assets.large_url(album_url.clone());
		}
	}
	if let Some(avatar) = &track.artist_avatar_url {
		assets = assets
			.small_image(avatar.as_str())
			.small_text(artist_name.as_str());
		if let Some(artist_url) = &track.artist_url {
			assets = assets.small_url(artist_url.as_str());
		}
	}

	let mut timestamps = activity::Timestamps::new();
	if track.playing {
		let elapsed_ms = (track.elapsed_secs.max(0.0) * 1000.0) as i64;
		let start = now_ms() - elapsed_ms;
		timestamps = timestamps.start(start);
		if track.duration_secs > 0.0 {
			timestamps = timestamps.end(start + (track.duration_secs * 1000.0) as i64);
		}
	}

	// Discord allows at most two buttons; the song and the artist/album
	// (whichever is available) make good fallbacks for older clients that
	// ignore the detail/state hyperlinks.
	let mut buttons = vec![activity::Button::new("Open song", &track.song_url)];
	let secondary = track
		.album_url
		.as_ref()
		.map(|url| activity::Button::new("View album", url))
		.or_else(|| {
			track
				.artist_url
				.as_ref()
				.map(|url| activity::Button::new("View artist", url))
		});
	if let Some(button) = secondary {
		buttons.push(button);
	}

	let mut act = activity::Activity::new()
		.activity_type(activity::ActivityType::Listening)
		.details(clamp(&track.title, 128))
		.state(artist_name.as_str())
		.details_url(&track.song_url)
		.assets(assets)
		.timestamps(timestamps)
		.buttons(buttons);
	if let Some(artist_url) = &track.artist_url {
		act = act.state_url(artist_url.clone());
	}

	client.set_activity(act).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
fn clear_desktop_activity() -> Result<(), String> {
	let mut guard = DISCORD.lock().map_err(|_| "discord state poisoned")?;
	if let Some(client) = guard.as_mut() {
		client.clear_activity().map_err(|e| e.to_string())?;
	}
	Ok(())
}

pub fn shutdown() {
	#[cfg(not(target_os = "android"))]
	{
		if let Ok(mut guard) = DISCORD.lock() {
			if let Some(mut client) = guard.take() {
				let _ = client.clear_activity();
				let _ = client.close();
			}
		}
	}
}

#[tauri::command]
pub async fn set_discord_activity(track: TrackPresence) -> Result<(), String> {
	#[cfg(target_os = "android")]
	{
		let data = serde_json::to_string(
			&serde_json::json!({ "applicationId": APPLICATION_ID, "track": track }),
		)
		.map_err(|e| e.to_string())?;
		android_presence(Some(data)).await
	}
	#[cfg(not(target_os = "android"))]
	set_desktop_activity(track)
}

#[tauri::command]
pub async fn clear_discord_activity() -> Result<(), String> {
	#[cfg(target_os = "android")]
	{
		android_presence(None).await
	}
	#[cfg(not(target_os = "android"))]
	clear_desktop_activity()
}

#[cfg(target_os = "android")]
async fn android_presence(data: Option<String>) -> Result<(), String> {
	use tauri_runtime_wry::wry::prelude::jni::objects::JValue;
	crate::android_activity::call(move |env, activity| {
		if let Some(data) = data {
			let payload = env.new_string(data)?;
			env.call_method(
				activity,
				"updateDiscordPresence",
				"(Ljava/lang/String;)V",
				&[JValue::Object(&payload)],
			)?;
		} else {
			env.call_method(activity, "clearDiscordPresence", "()V", &[])?;
		}
		Ok(())
	})
	.await
}
