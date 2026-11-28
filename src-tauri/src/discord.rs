#[cfg(not(target_os = "android"))]
use std::sync::Mutex;
#[cfg(not(target_os = "android"))]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(not(target_os = "android"))]
use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "android"))]
const PAUSED_PRESENCE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
#[cfg(not(target_os = "android"))]
static DISCORD: Mutex<DesktopPresence> = Mutex::new(DesktopPresence {
	client: None,
	pause_deadline: None,
});

#[cfg(not(target_os = "android"))]
#[derive(Default)]
struct DesktopPresence {
	client: Option<DiscordIpcClient>,
	pause_deadline: Option<SystemTime>,
}

#[cfg(not(target_os = "android"))]
impl DesktopPresence {
	fn update_playback(&mut self, playing: bool, now: SystemTime) -> Option<SystemTime> {
		if playing {
			self.pause_deadline = None;
		} else if self.pause_deadline.is_none() {
			let deadline = now + PAUSED_PRESENCE_TIMEOUT;
			self.pause_deadline = Some(deadline);
			return Some(deadline);
		}
		None
	}

	fn pause_expired(&self, now: SystemTime) -> bool {
		self.pause_deadline.is_some_and(|deadline| now >= deadline)
	}

	fn clear_activity(&mut self) -> Result<(), String> {
		// Release the IPC connection even when Discord fails to accept the clear.
		if let Some(mut client) = self.client.take() {
			client.clear_activity().map_err(|error| error.to_string())?;
		}
		Ok(())
	}
}

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
	let mut presence = DISCORD.lock().map_err(|_| "discord state poisoned")?;
	let now = SystemTime::now();
	if let Some(deadline) = presence.update_playback(track.playing, now) {
		tauri::async_runtime::spawn(expire_desktop_activity(deadline));
	}
	if presence.pause_expired(now) {
		return presence.clear_activity();
	}

	let client = match presence.client.as_mut() {
		Some(client) => client,
		None => {
			let mut client = DiscordIpcClient::new(APPLICATION_ID);
			client.connect().map_err(|e| e.to_string())?;
			presence.client.insert(client)
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

	if let Err(error) = client.set_activity(act) {
		// The next update can reconnect after Discord has restarted.
		presence.client = None;
		return Err(error.to_string());
	}
	Ok(())
}

#[cfg(not(target_os = "android"))]
async fn expire_desktop_activity(deadline: SystemTime) {
	loop {
		// Poll the wall clock so time spent in system sleep counts toward expiry.
		let remaining = deadline
			.duration_since(SystemTime::now())
			.unwrap_or_default();
		tokio::time::sleep(remaining.min(Duration::from_secs(30))).await;

		let Ok(mut presence) = DISCORD.lock() else {
			return;
		};
		if presence.pause_deadline != Some(deadline) {
			return;
		}
		if presence.pause_expired(SystemTime::now()) {
			if let Err(error) = presence.clear_activity() {
				log::warn!("[discord] clearing expired presence failed: {error}");
			}
			return;
		}
	}
}

#[cfg(not(target_os = "android"))]
fn clear_desktop_activity() -> Result<(), String> {
	let mut presence = DISCORD.lock().map_err(|_| "discord state poisoned")?;
	presence.pause_deadline = None;
	presence.clear_activity()
}

pub fn shutdown() {
	#[cfg(not(target_os = "android"))]
	{
		let _ = clear_desktop_activity();
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

#[cfg(all(test, not(target_os = "android")))]
mod tests {
	use super::*;

	#[test]
	fn paused_updates_keep_the_original_deadline_even_after_expiry() {
		let mut presence = DesktopPresence::default();
		let deadline = UNIX_EPOCH + PAUSED_PRESENCE_TIMEOUT;
		let before_expiry = deadline - Duration::from_secs(1);
		let after_sleep = UNIX_EPOCH + Duration::from_secs(3600);

		assert_eq!(presence.update_playback(false, UNIX_EPOCH), Some(deadline));
		assert_eq!(presence.update_playback(false, before_expiry), None);
		assert!(!presence.pause_expired(before_expiry));
		assert!(presence.pause_expired(deadline));
		assert_eq!(presence.update_playback(false, after_sleep), None);
		assert!(presence.pause_expired(after_sleep));
	}

	#[test]
	fn resuming_cancels_expiry_and_the_next_pause_gets_its_own_deadline() {
		let mut presence = DesktopPresence::default();
		let first_deadline = presence.update_playback(false, UNIX_EPOCH).unwrap();
		let resume = UNIX_EPOCH + Duration::from_secs(10);
		let second_pause = resume + Duration::from_secs(10);

		assert_eq!(presence.update_playback(true, resume), None);
		assert!(!presence.pause_expired(first_deadline));
		assert_eq!(
			presence.update_playback(false, second_pause),
			Some(second_pause + PAUSED_PRESENCE_TIMEOUT),
		);
		assert!(!presence.pause_expired(first_deadline));
	}

	#[test]
	fn expiry_discards_a_failed_ipc_connection_without_frontend_updates() {
		let deadline = UNIX_EPOCH + PAUSED_PRESENCE_TIMEOUT;
		{
			let mut presence = DISCORD.lock().unwrap();
			presence.pause_deadline = Some(deadline);
			presence.client = Some(DiscordIpcClient::new(APPLICATION_ID));
		}

		tauri::async_runtime::block_on(expire_desktop_activity(deadline));

		let mut presence = DISCORD.lock().unwrap();
		assert_eq!(presence.pause_deadline.take(), Some(deadline));
		assert!(presence.client.is_none());
	}
}
