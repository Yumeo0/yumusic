//! Native OS media session (Windows SMTC, macOS Now Playing, Linux MPRIS)
//! via playwire. Owning the session natively is what gives the system the
//! app's real name and icon — WebView2's web MediaSession shows "Unknown
//! App" — and delivers the hardware media keys to the player.

use std::sync::Mutex;
use std::time::Duration;

use playwire::{
	Capabilities, Event, MediaControls, PlaybackState, PlayerConfig, Repeat, Track,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Snapshot of the player, pushed from the frontend.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaState {
	pub id: Option<String>,
	pub title: Option<String>,
	pub artist: Option<String>,
	pub album: Option<String>,
	pub cover_url: Option<String>,
	pub playing: bool,
	pub position: f64,
	pub duration: Option<f64>,
	pub can_go_next: bool,
	pub can_go_previous: bool,
}

/// A hardware media key / overlay action forwarded to the frontend.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaControlAction {
	action: &'static str,
	position: Option<f64>,
}

fn control_action(event: Event) -> Option<MediaControlAction> {
	let action = match event {
		Event::Play => "play",
		Event::Pause => "pause",
		Event::PlayPause => "toggle",
		Event::Stop => "stop",
		Event::Next => "next",
		Event::Previous => "previous",
		Event::SeekTo(position) => {
			return Some(MediaControlAction {
				action: "set-position",
				position: Some(position.as_secs_f64()),
			});
		}
		Event::SeekBy(offset) => {
			return Some(MediaControlAction {
				action: "seek-by",
				position: Some(offset),
			});
		}
		_ => return None,
	};
	Some(MediaControlAction {
		action,
		position: None,
	})
}

#[derive(Default)]
pub struct MediaSession {
	controls: Mutex<Option<MediaControls>>,
}

impl MediaSession {
	/// Binds the OS session to the main window (required on Windows) and
	/// forwards media key presses to the frontend as `media-control` events.
	pub fn init(&self, app: &AppHandle, hwnd: Option<u64>) {
		let mut slot = self.controls.lock().expect("media controls lock");
		if slot.is_some() {
			return;
		}
		let mut config = PlayerConfig::new("YuMusic")
			.desktop_entry("dev.yumeo.yumusic")
			.track_id_prefix("/dev/yumeo/yumusic/track");
		config.bus_name = "dev.yumeo.yumusic".to_string();
		if let Some(hwnd) = hwnd {
			config = config.hwnd(hwnd);
		}
		let app = app.clone();
		let controls = match MediaControls::new(config, move |event| {
			if let Some(action) = control_action(event) {
				let _ = app.emit("media-control", action);
			}
		}) {
			Ok(controls) => controls,
			Err(error) => {
				eprintln!("[media] native session unavailable: {error}");
				return;
			}
		};
		*slot = Some(controls);
	}

	/// Publishes a snapshot; playwire diffs it against the last one, so a
	/// position tick only moves the timeline.
	pub fn update(&self, snapshot: MediaState) {
		let mut slot = self.controls.lock().expect("media controls lock");
		let Some(controls) = slot.as_mut() else {
			return;
		};
		let track = snapshot.title.map(|title| Track {
			id: snapshot.id.unwrap_or_default(),
			title,
			artists: snapshot.artist.into_iter().collect(),
			album: snapshot.album.unwrap_or_default(),
			artwork_url: snapshot.cover_url.unwrap_or_default(),
			url: String::new(),
		});
		let duration = snapshot
			.duration
			.filter(|seconds| seconds.is_finite() && *seconds > 0.0)
			.map(Duration::from_secs_f64);
		let state = PlaybackState {
			track,
			playing: snapshot.playing,
			position: Duration::from_secs_f64(snapshot.position.max(0.0)),
			duration,
			volume: 1.0,
			repeat: Repeat::Off,
			shuffle: false,
			capabilities: Capabilities {
				can_go_next: snapshot.can_go_next,
				can_go_previous: snapshot.can_go_previous,
				can_seek: duration.is_some(),
			},
		};
		if let Err(error) = controls.set_state(&state) {
			eprintln!("[media] set_state failed: {error}");
		}
	}
}

#[tauri::command]
pub fn update_media_session(app: AppHandle, snapshot: MediaState) {
	use tauri::Manager;
	app.state::<MediaSession>().update(snapshot);
}
