use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// A completed download, persisted in `downloads/index.json`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEntry {
	pub id: String,
	pub title: String,
	pub artist: String,
	pub duration: Option<String>,
	pub thumbnail: Option<String>,
	pub ext: String,
	pub size: u64,
	/// Absolute path of the audio file, loaded through the asset protocol.
	pub path: String,
	pub downloaded_at: u64,
}

/// Metadata the frontend sends when finishing a download.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMetadata {
	pub id: String,
	pub title: String,
	pub artist: String,
	pub duration: Option<String>,
	pub thumbnail: Option<String>,
	pub ext: String,
}

/// An in-flight download: the temp file that chunks are appended to.
struct PendingDownload {
	temp: PathBuf,
}

static PENDING: Mutex<Option<HashMap<String, PendingDownload>>> = Mutex::new(None);

const DOWNLOADS_DIR: &str = "downloads";
const AUDIO_DIR: &str = "audio";
const TEMP_DIR: &str = "tmp";
const INDEX_FILE: &str = "index.json";
/// Temp chunks older than this are leftovers from interrupted runs.
const STALE_TEMP_AGE: Duration = Duration::from_secs(24 * 60 * 60);

fn downloads_root(app: &AppHandle) -> Result<PathBuf, String> {
	let dir = app
		.path()
		.app_data_dir()
		.map_err(|e| e.to_string())?
		.join(DOWNLOADS_DIR);
	fs::create_dir_all(dir.join(AUDIO_DIR)).map_err(|e| e.to_string())?;
	fs::create_dir_all(dir.join(TEMP_DIR)).map_err(|e| e.to_string())?;
	Ok(dir)
}

fn index_path(root: &Path) -> PathBuf {
	root.join(INDEX_FILE)
}

fn read_index(root: &Path) -> Vec<DownloadEntry> {
	let Ok(raw) = fs::read_to_string(index_path(root)) else {
		return Vec::new();
	};
	serde_json::from_str(&raw).unwrap_or_default()
}

fn write_index(root: &Path, entries: &[DownloadEntry]) -> Result<(), String> {
	let raw = serde_json::to_string(entries).map_err(|e| e.to_string())?;
	fs::write(index_path(root), raw).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map(|duration| duration.as_millis() as u64)
		.unwrap_or(0)
}

/// YouTube ids are URL-safe; reject anything else so the value never escapes
/// the downloads directory when used as a file name.
fn safe_id(id: &str) -> Result<&str, String> {
	if !id.is_empty()
		&& id
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
	{
		Ok(id)
	} else {
		Err(format!("invalid download id \"{id}\""))
	}
}

/// Extensions the downloader can produce; anything else is rejected.
fn safe_ext(ext: &str) -> Result<&str, String> {
	match ext {
		"webm" | "mp4" | "m4a" | "bin" => Ok(ext),
		_ => Err(format!("invalid download extension \"{ext}\"")),
	}
}

/// Removes leftover temp chunks from interrupted downloads. Active sessions
/// are always younger than the cutoff, so they are never touched.
fn cleanup_stale_temp(root: &Path) {
	let Ok(dir) = fs::read_dir(root.join(TEMP_DIR)) else {
		return;
	};
	let now = SystemTime::now();
	for item in dir.flatten() {
		let stale = item
			.metadata()
			.and_then(|meta| meta.modified())
			.ok()
			.and_then(|modified| now.duration_since(modified).ok())
			.is_some_and(|age| age > STALE_TEMP_AGE);
		if stale {
			let _ = fs::remove_file(item.path());
		}
	}
}

/// Starts a download session and returns its token. Chunks are appended to a
/// temp file and only become visible to the app when `download_finish` runs.
#[tauri::command]
pub async fn download_begin(app: AppHandle, song_id: String, ext: String) -> Result<String, String> {
	let id = safe_id(&song_id)?.to_owned();
	let ext = safe_ext(&ext)?.to_owned();
	let root = downloads_root(&app)?;
	cleanup_stale_temp(&root);

	let token = format!("{id}-{}", now_ms());
	let temp = root.join(TEMP_DIR).join(format!("{token}.{ext}"));
	let _ = fs::remove_file(&temp);
	fs::File::create(&temp).map_err(|e| e.to_string())?;

	let mut guard = PENDING.lock().map_err(|_| "download state poisoned")?;
	guard
		.get_or_insert_with(HashMap::new)
		.insert(token.clone(), PendingDownload { temp });
	Ok(token)
}

/// Appends one base64-encoded chunk of audio to the session's temp file.
#[tauri::command]
pub async fn download_append(token: String, data: String) -> Result<(), String> {
	let temp = {
		let guard = PENDING.lock().map_err(|_| "download state poisoned")?;
		guard
			.as_ref()
			.and_then(|sessions| sessions.get(&token))
			.map(|session| session.temp.clone())
			.ok_or_else(|| "unknown download".to_string())?
	};
	let bytes = base64::engine::general_purpose::STANDARD
		.decode(data)
		.map_err(|e| e.to_string())?;
	let mut file = fs::OpenOptions::new()
		.append(true)
		.open(&temp)
		.map_err(|e| e.to_string())?;
	file.write_all(&bytes).map_err(|e| e.to_string())
}

/// Finalizes a session: moves the temp file into the audio directory and
/// records it in the index (replacing any previous file for the same song).
#[tauri::command]
pub async fn download_finish(
	app: AppHandle,
	token: String,
	metadata: DownloadMetadata,
) -> Result<DownloadEntry, String> {
	let pending = {
		let mut guard = PENDING.lock().map_err(|_| "download state poisoned")?;
		guard
			.as_mut()
			.and_then(|sessions| sessions.remove(&token))
			.ok_or_else(|| "unknown download".to_string())?
	};
	let id = safe_id(&metadata.id)?.to_owned();
	let ext = safe_ext(&metadata.ext)?.to_owned();
	let root = downloads_root(&app)?;
	let final_path = root.join(AUDIO_DIR).join(format!("{id}.{ext}"));
	// A re-download replaces the previous file.
	let _ = fs::remove_file(&final_path);
	fs::rename(&pending.temp, &final_path).map_err(|e| e.to_string())?;

	let size = fs::metadata(&final_path).map_err(|e| e.to_string())?.len();
	let entry = DownloadEntry {
		id,
		title: metadata.title,
		artist: metadata.artist,
		duration: metadata.duration,
		thumbnail: metadata.thumbnail,
		ext,
		size,
		path: final_path.to_string_lossy().into_owned(),
		downloaded_at: now_ms(),
	};

	let mut entries = read_index(&root);
	// A re-download may land in a different container; drop the old file.
	if let Some(previous) = entries.iter().find(|existing| existing.id == entry.id) {
		if previous.path != entry.path {
			let _ = fs::remove_file(&previous.path);
		}
	}
	entries.retain(|existing| existing.id != entry.id);
	entries.push(entry.clone());
	write_index(&root, &entries)?;
	Ok(entry)
}

/// Drops an unfinished session and its temp file.
#[tauri::command]
pub async fn download_abort(token: String) -> Result<(), String> {
	let pending = {
		let mut guard = PENDING.lock().map_err(|_| "download state poisoned")?;
		guard
			.as_mut()
			.and_then(|sessions| sessions.remove(&token))
	};
	if let Some(pending) = pending {
		let _ = fs::remove_file(&pending.temp);
	}
	Ok(())
}

/// The stored downloads, with sizes refreshed from disk. Entries whose file
/// disappeared (manual deletion, cleared data) are dropped from the index.
#[tauri::command]
pub async fn downloads_list(app: AppHandle) -> Result<Vec<DownloadEntry>, String> {
	let root = downloads_root(&app)?;
	cleanup_stale_temp(&root);
	let mut entries = read_index(&root);
	let mut changed = false;
	entries.retain_mut(|entry| match fs::metadata(&entry.path) {
		Ok(meta) if meta.is_file() => {
			if entry.size != meta.len() {
				entry.size = meta.len();
				changed = true;
			}
			true
		}
		_ => {
			changed = true;
			false
		}
	});
	if changed {
		write_index(&root, &entries)?;
	}
	Ok(entries)
}

/// Removes the given downloads from disk and the index. Returns the ids that
/// could not be removed — on Windows a file that the webview is currently
/// playing cannot be deleted.
#[tauri::command]
pub async fn downloads_remove(app: AppHandle, ids: Vec<String>) -> Result<Vec<String>, String> {
	let root = downloads_root(&app)?;
	let mut entries = read_index(&root);
	let mut failed: Vec<String> = Vec::new();
	for id in &ids {
		let Some(position) = entries.iter().position(|entry| &entry.id == id) else {
			continue;
		};
		let entry = entries[position].clone();
		match fs::remove_file(&entry.path) {
			Ok(()) => {
				entries.remove(position);
			}
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				entries.remove(position);
			}
			Err(_) => failed.push(id.clone()),
		}
	}
	write_index(&root, &entries)?;
	Ok(failed)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn test_root(name: &str) -> PathBuf {
		let root = std::env::temp_dir().join(format!("yumusic-downloads-{name}-{}", now_ms()));
		fs::create_dir_all(root.join(AUDIO_DIR)).unwrap();
		fs::create_dir_all(root.join(TEMP_DIR)).unwrap();
		root
	}

	fn entry(id: &str) -> DownloadEntry {
		DownloadEntry {
			id: id.to_owned(),
			title: "Song".to_owned(),
			artist: "Artist".to_owned(),
			duration: Some("3:00".to_owned()),
			thumbnail: None,
			ext: "webm".to_owned(),
			size: 1234,
			path: format!("/nonexistent/{id}.webm"),
			downloaded_at: 1,
		}
	}

	#[test]
	fn ids_cannot_escape_the_downloads_directory() {
		assert!(safe_id("dQw4w9WgXcQ").is_ok());
		assert!(safe_id("abc-123_x").is_ok());
		assert!(safe_id("").is_err());
		assert!(safe_id("../evil").is_err());
		assert!(safe_id("a/b").is_err());
		assert!(safe_id("a\\b").is_err());
	}

	#[test]
	fn extensions_are_limited_to_known_containers() {
		assert!(safe_ext("webm").is_ok());
		assert!(safe_ext("mp4").is_ok());
		assert!(safe_ext("m4a").is_ok());
		assert!(safe_ext("bin").is_ok());
		assert!(safe_ext("exe").is_err());
	}

	#[test]
	fn index_round_trips() {
		let root = test_root("index");
		write_index(&root, &[entry("abc"), entry("def")]).unwrap();
		let loaded = read_index(&root);
		assert_eq!(loaded.len(), 2);
		assert_eq!(loaded[0].id, "abc");
		assert_eq!(loaded[1].size, 1234);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn missing_index_reads_as_empty() {
		let root = test_root("missing");
		assert!(read_index(&root).is_empty());
		let _ = fs::remove_dir_all(&root);
	}
}
