use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// A completed download, persisted in `downloads/index.json`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadEntry {
	pub id: String,
	pub title: String,
	pub artist: String,
	pub duration: Option<String>,
	pub thumbnail: Option<String>,
	/// Uploader description, used to refine the title/artist on playback.
	/// Older indexes have no such field.
	#[serde(default)]
	pub description: Option<String>,
	pub ext: String,
	pub size: u64,
	/// Absolute path of the audio file, loaded through the asset protocol.
	pub path: String,
	pub downloaded_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadMetadata {
	title: String,
	artist: String,
	duration: Option<String>,
	thumbnail: Option<String>,
	#[serde(default)]
	description: Option<String>,
}

struct PendingDownload {
	id: String,
	ext: String,
	temp: PathBuf,
}

#[derive(Default)]
pub struct DownloadStore(Mutex<HashMap<String, PendingDownload>>);

impl DownloadStore {
	fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, PendingDownload>>, String> {
		self.0.lock().map_err(|_| "download state poisoned".into())
	}
}

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

// Separate app instances share the same persisted index.
fn lock_index(root: &Path) -> Result<fs::File, String> {
	let file = fs::OpenOptions::new()
		.read(true)
		.write(true)
		.create(true)
		.truncate(false)
		.open(root.join("index.lock"))
		.map_err(|error| error.to_string())?;
	file.lock().map_err(|error| error.to_string())?;
	Ok(file)
}

fn read_index(root: &Path) -> Result<Vec<DownloadEntry>, String> {
	match fs::read_to_string(index_path(root)) {
		Ok(raw) => serde_json::from_str(&raw).map_err(|error| error.to_string()),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
		Err(error) => Err(error.to_string()),
	}
}

fn write_index(root: &Path, entries: &[DownloadEntry]) -> Result<(), String> {
	let raw = serde_json::to_vec(entries).map_err(|e| e.to_string())?;
	let staging = root
		.join(TEMP_DIR)
		.join(format!("index-{}.json", operation_id()));
	let result = (|| {
		let mut file = fs::File::create_new(&staging)?;
		file.write_all(&raw)?;
		file.sync_all()?;
		drop(file);
		fs::rename(&staging, index_path(root))
	})();
	if result.is_err() {
		let _ = fs::remove_file(&staging);
	}
	result.map_err(|error: std::io::Error| error.to_string())
}

fn operation_id() -> String {
	static SEQUENCE: AtomicU64 = AtomicU64::new(0);
	format!(
		"{}-{}-{}",
		now_ms(),
		std::process::id(),
		SEQUENCE.fetch_add(1, Ordering::Relaxed)
	)
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

/// Cleans up temporary files left by an interrupted run.
fn cleanup_stale_temp(root: &Path, active: &HashMap<String, PendingDownload>) {
	let Ok(dir) = fs::read_dir(root.join(TEMP_DIR)) else {
		return;
	};
	let now = SystemTime::now();
	for item in dir.flatten() {
		let path = item.path();
		if active.values().any(|pending| pending.temp == path) {
			continue;
		}
		let stale = item
			.metadata()
			.and_then(|meta| meta.modified())
			.ok()
			.and_then(|modified| now.duration_since(modified).ok())
			.is_some_and(|age| age > STALE_TEMP_AGE);
		if stale {
			let _ = fs::remove_file(path);
		}
	}
}

#[tauri::command]
pub async fn download_begin(
	app: AppHandle,
	store: State<'_, DownloadStore>,
	song_id: String,
	ext: String,
) -> Result<String, String> {
	let id = safe_id(&song_id)?.to_owned();
	let ext = safe_ext(&ext)?.to_owned();
	let root = downloads_root(&app)?;
	let mut sessions = store.lock()?;
	cleanup_stale_temp(&root, &sessions);
	let token = operation_id();
	let temp = root.join(TEMP_DIR).join(format!("{id}-{token}.{ext}"));
	fs::File::create_new(&temp).map_err(|e| e.to_string())?;
	sessions.insert(token.clone(), PendingDownload { id, ext, temp });
	Ok(token)
}

#[tauri::command]
pub async fn download_append(
	store: State<'_, DownloadStore>,
	token: String,
	data: String,
) -> Result<(), String> {
	let bytes = base64::engine::general_purpose::STANDARD
		.decode(data)
		.map_err(|e| e.to_string())?;
	let sessions = store.lock()?;
	let pending = sessions.get(&token).ok_or("unknown download")?;
	let mut file = fs::OpenOptions::new()
		.append(true)
		.open(&pending.temp)
		.map_err(|e| e.to_string())?;
	file.write_all(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn download_finish(
	app: AppHandle,
	store: State<'_, DownloadStore>,
	token: String,
	metadata: DownloadMetadata,
) -> Result<DownloadEntry, String> {
	let root = downloads_root(&app)?;
	let mut sessions = store.lock()?;
	let pending = sessions.get(&token).ok_or("unknown download")?;
	let _index = lock_index(&root)?;
	let entry = commit_download(&root, &token, pending, metadata)?;
	sessions.remove(&token);
	Ok(entry)
}

fn commit_download(
	root: &Path,
	token: &str,
	pending: &PendingDownload,
	metadata: DownloadMetadata,
) -> Result<DownloadEntry, String> {
	let final_path = root
		.join(AUDIO_DIR)
		.join(format!("download-{token}.{}", pending.ext));
	let size = fs::metadata(&pending.temp)
		.map_err(|e| e.to_string())?
		.len();
	let entry = DownloadEntry {
		id: pending.id.clone(),
		title: metadata.title,
		artist: metadata.artist,
		duration: metadata.duration,
		thumbnail: metadata.thumbnail,
		description: metadata.description,
		ext: pending.ext.clone(),
		size,
		path: final_path.to_string_lossy().into_owned(),
		downloaded_at: now_ms(),
	};
	let mut entries = read_index(root)?;
	let previous = entries
		.iter()
		.find(|existing| existing.id == entry.id)
		.cloned();
	entries.retain(|existing| existing.id != entry.id);
	entries.push(entry.clone());

	// A new path keeps the previously indexed file playable until the commit succeeds.
	fs::rename(&pending.temp, &final_path).map_err(|e| e.to_string())?;
	if let Err(error) = write_index(root, &entries) {
		if let Err(restore) = fs::rename(&final_path, &pending.temp) {
			return Err(format!(
				"{error}; could not restore the pending download: {restore}"
			));
		}
		return Err(error);
	}
	if let Some(previous) = previous {
		let path = Path::new(&previous.path);
		if path.parent() == Some(root.join(AUDIO_DIR).as_path()) {
			let _ = fs::remove_file(path);
		}
	}
	Ok(entry)
}

#[tauri::command]
pub async fn download_abort(store: State<'_, DownloadStore>, token: String) -> Result<(), String> {
	if let Some(pending) = store.lock()?.remove(&token) {
		let _ = fs::remove_file(pending.temp);
	}
	Ok(())
}

// A crash during promotion, or a Windows file still in use at replacement,
// can leave an app-managed media file outside the index.
fn is_managed_audio(path: &Path) -> bool {
	let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
		return false;
	};
	let Some(token) = stem.strip_prefix("download-") else {
		return false;
	};
	let mut parts = token.split('-');
	let valid_token = (0..3).all(|_| parts.next().is_some_and(|part| part.parse::<u64>().is_ok()))
		&& parts.next().is_none();
	valid_token
		&& path
			.extension()
			.and_then(|ext| ext.to_str())
			.is_some_and(|ext| safe_ext(ext).is_ok())
}

fn cleanup_unindexed_audio(root: &Path, entries: &[DownloadEntry]) {
	let Ok(dir) = fs::read_dir(root.join(AUDIO_DIR)) else {
		return;
	};
	let indexed: std::collections::HashSet<_> =
		entries.iter().map(|entry| Path::new(&entry.path)).collect();
	let now = SystemTime::now();
	for item in dir.flatten() {
		let path = item.path();
		if !item.file_type().is_ok_and(|kind| kind.is_file())
			|| !is_managed_audio(&path)
			|| indexed.contains(path.as_path())
		{
			continue;
		}
		let old = item
			.metadata()
			.and_then(|metadata| metadata.modified())
			.ok()
			.and_then(|modified| now.duration_since(modified).ok())
			.is_some_and(|age| age > STALE_TEMP_AGE);
		if old {
			let _ = fs::remove_file(path);
		}
	}
}

/// Reconciles index entries with on-disk sizes and missing files.
#[tauri::command]
pub async fn downloads_list(
	app: AppHandle,
	store: State<'_, DownloadStore>,
) -> Result<Vec<DownloadEntry>, String> {
	let root = downloads_root(&app)?;
	let sessions = store.lock()?;
	cleanup_stale_temp(&root, &sessions);
	let _index = lock_index(&root)?;
	let mut entries = read_index(&root)?;
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
	cleanup_unindexed_audio(&root, &entries);
	Ok(entries)
}

/// Returns ids whose files could not be removed, such as open media on Windows.
#[tauri::command]
pub async fn downloads_remove(
	app: AppHandle,
	store: State<'_, DownloadStore>,
	ids: Vec<String>,
) -> Result<Vec<String>, String> {
	let root = downloads_root(&app)?;
	let mut sessions = store.lock()?;
	sessions.retain(|_, pending| {
		if !ids.contains(&pending.id) {
			return true;
		}
		let _ = fs::remove_file(&pending.temp);
		false
	});
	let _index = lock_index(&root)?;
	let mut entries = read_index(&root)?;
	let mut staged = Vec::new();
	let mut failed = Vec::new();
	for id in &ids {
		let Some(position) = entries.iter().position(|entry| &entry.id == id) else {
			continue;
		};
		let path = PathBuf::from(&entries[position].path);
		let temporary = root
			.join(TEMP_DIR)
			.join(format!("removed-{}", operation_id()));
		match fs::rename(&path, &temporary) {
			Ok(()) => {
				staged.push((path, temporary));
				entries.remove(position);
			}
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
				entries.remove(position);
			}
			Err(_) => failed.push(id.clone()),
		}
	}
	let result = write_index(&root, &entries);
	for (path, temporary) in staged {
		if result.is_ok() {
			let _ = fs::remove_file(temporary);
		} else if let Err(error) = fs::rename(temporary, path) {
			log::warn!("Could not restore a staged download: {error}");
		}
	}
	result?;
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
			description: Some("Singer: Artist".to_owned()),
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
		let loaded = read_index(&root).unwrap();
		assert_eq!(loaded.len(), 2);
		assert_eq!(loaded[0].id, "abc");
		assert_eq!(loaded[0].description.as_deref(), Some("Singer: Artist"));
		assert_eq!(loaded[1].size, 1234);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn legacy_entries_without_a_description_still_load() {
		let root = test_root("legacy");
		let legacy = r#"[{"id":"abc","title":"Song","artist":"Artist","duration":null,"thumbnail":null,"ext":"webm","size":1,"path":"/nonexistent/abc.webm","downloadedAt":1}]"#;
		fs::write(index_path(&root), legacy).unwrap();
		let loaded = read_index(&root).unwrap();
		assert_eq!(loaded.len(), 1);
		assert_eq!(loaded[0].description, None);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn committed_replacement_keeps_only_the_new_media_and_index_entry() {
		let root = test_root("replacement");
		let old_path = root.join(AUDIO_DIR).join("abc.webm");
		fs::write(&old_path, b"old").unwrap();
		let mut old = entry("abc");
		old.path = old_path.to_string_lossy().into_owned();
		write_index(&root, &[old]).unwrap();

		let temp = root.join(TEMP_DIR).join("incoming.mp4");
		fs::write(&temp, b"new media").unwrap();
		let pending = PendingDownload {
			id: "abc".into(),
			ext: "mp4".into(),
			temp,
		};
		let metadata = DownloadMetadata {
			title: "Updated title".into(),
			artist: "Artist".into(),
			duration: None,
			thumbnail: None,
			description: None,
		};
		let saved = commit_download(&root, &operation_id(), &pending, metadata).unwrap();
		let entries = read_index(&root).unwrap();
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].path, saved.path);
		assert!(is_managed_audio(Path::new(&saved.path)));
		assert_eq!(entries[0].title, "Updated title");
		assert_eq!(fs::read(&saved.path).unwrap(), b"new media");
		assert!(!old_path.exists());
		fs::remove_dir_all(root).unwrap();
	}

	#[test]
	fn missing_index_reads_as_empty() {
		let root = test_root("missing");
		assert!(read_index(&root).unwrap().is_empty());
		let _ = fs::remove_dir_all(&root);
	}
}
