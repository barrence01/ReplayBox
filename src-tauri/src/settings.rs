use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Default watch directory for game recordings (user-configurable).
pub const DEFAULT_WATCH_DIR: &str =
    "/run/media/williambarrence/HDD/WilliamBarrence/Gravacoes";

/// XDG-aligned application directories resolved via Tauri `PathResolver`.
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub log_dir: PathBuf,
    pub cache_dir: PathBuf,
}

impl AppPaths {
    /// Resolve config, data, log, and cache directories for the running app.
    pub fn resolve(app: &tauri::App) -> Result<Self, String> {
        let path = app.path();
        Ok(Self {
            config_dir: path.app_config_dir().map_err(|e| e.to_string())?,
            data_dir: path.app_data_dir().map_err(|e| e.to_string())?,
            log_dir: path.app_log_dir().map_err(|e| e.to_string())?,
            cache_dir: path.app_cache_dir().map_err(|e| e.to_string())?,
        })
    }

    pub fn settings_path(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("replaybox.db")
    }

    pub fn thumbs_dir(&self) -> PathBuf {
        self.cache_dir.join("thumbnails")
    }

    pub fn playback_cache_dir(&self) -> PathBuf {
        self.cache_dir.join("playback")
    }
}

/// Default maximum preview cache size in gigabytes.
pub const DEFAULT_PLAYBACK_CACHE_MAX_GB: u32 = 5;

pub fn default_playback_cache_max_gb() -> u32 {
    DEFAULT_PLAYBACK_CACHE_MAX_GB
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub watch_dir: String,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub compress_crf: u8,
    pub prefer_nvenc: bool,
    #[serde(default)]
    pub launch_on_startup: bool,
    #[serde(default = "default_playback_cache_max_gb")]
    pub playback_cache_max_gb: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            watch_dir: DEFAULT_WATCH_DIR.to_string(),
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            compress_crf: 26,
            prefer_nvenc: true,
            launch_on_startup: false,
            playback_cache_max_gb: DEFAULT_PLAYBACK_CACHE_MAX_GB,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, raw).map_err(|e| e.to_string())
    }

    pub fn playback_cache_max_bytes(&self) -> u64 {
        self.playback_cache_max_gb as u64 * 1024 * 1024 * 1024
    }
}

/// Ensure the watch folder exists, is a directory, and is readable.
pub fn validate_watch_dir(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Watch folder path is empty.".to_string());
    }

    let path = Path::new(trimmed);
    if !path.exists() {
        return Err(format!("Watch folder does not exist: {trimmed}"));
    }
    if !path.is_dir() {
        return Err(format!("Watch folder is not a directory: {trimmed}"));
    }

    fs::read_dir(path).map_err(|e| {
        format!("Watch folder is not accessible: {trimmed} ({e})")
    })?;

    Ok(())
}

/// Preview cache limit must stay within a safe range (1–100 GB).
pub fn validate_playback_cache_max_gb(gb: u32) -> Result<(), String> {
    if !(1..=100).contains(&gb) {
        return Err("Preview cache limit must be between 1 and 100 GB.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn validate_watch_dir_accepts_readable_directory() {
        let dir = tempfile::tempdir().unwrap();
        assert!(validate_watch_dir(dir.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn validate_watch_dir_rejects_empty() {
        assert!(validate_watch_dir("").is_err());
        assert!(validate_watch_dir("   ").is_err());
    }

    #[test]
    fn validate_watch_dir_rejects_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert!(validate_watch_dir(missing.to_str().unwrap()).is_err());
    }

    #[test]
    fn validate_watch_dir_rejects_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("not-a-dir.txt");
        File::create(&file_path).unwrap();
        assert!(validate_watch_dir(file_path.to_str().unwrap()).is_err());
    }

    #[test]
    fn validate_watch_dir_rejects_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(&locked, perms).unwrap();

        let result = validate_watch_dir(locked.to_str().unwrap());

        let mut perms = fs::metadata(&locked).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&locked, perms).unwrap();

        assert!(result.is_err());
    }

    #[test]
    fn load_corrupt_json_returns_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{not json").unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.watch_dir, Settings::default().watch_dir);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let mut settings = Settings::default();
        settings.watch_dir = "/tmp/recordings".to_string();
        settings.compress_crf = 22;
        settings.prefer_nvenc = false;
        settings.launch_on_startup = true;
        settings.playback_cache_max_gb = 10;
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.watch_dir, "/tmp/recordings");
        assert_eq!(loaded.compress_crf, 22);
        assert!(!loaded.prefer_nvenc);
        assert!(loaded.launch_on_startup);
        assert_eq!(loaded.playback_cache_max_gb, 10);
    }

    #[test]
    fn load_legacy_json_defaults_playback_cache_max_gb() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{
              "watchDir": "/videos",
              "ffmpegPath": "",
              "ffprobePath": "",
              "compressCrf": 26,
              "preferNvenc": true,
              "gameProcessNames": ["cs2"],
              "backgroundServiceEnabled": true
            }"#,
        )
        .unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.watch_dir, "/videos");
        assert!(!loaded.launch_on_startup);
        assert_eq!(loaded.playback_cache_max_gb, DEFAULT_PLAYBACK_CACHE_MAX_GB);
    }

    #[test]
    fn default_playback_cache_max_gb_is_five() {
        assert_eq!(Settings::default().playback_cache_max_gb, 5);
        assert_eq!(
            Settings::default().playback_cache_max_bytes(),
            5 * 1024 * 1024 * 1024
        );
    }

    #[test]
    fn validate_playback_cache_max_gb_rejects_out_of_range() {
        assert!(validate_playback_cache_max_gb(0).is_err());
        assert!(validate_playback_cache_max_gb(101).is_err());
        assert!(validate_playback_cache_max_gb(1).is_ok());
        assert!(validate_playback_cache_max_gb(100).is_ok());
    }

    #[test]
    fn load_ignores_legacy_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{
              "watchDir": "/videos",
              "ffmpegPath": "",
              "ffprobePath": "",
              "compressCrf": 26,
              "preferNvenc": true,
              "launchOnStartup": false,
              "playbackCacheMaxGb": 8,
              "gameProcessNames": ["cs2"],
              "backgroundServiceEnabled": true
            }"#,
        )
        .unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.watch_dir, "/videos");
        assert!(!loaded.launch_on_startup);
        assert_eq!(loaded.playback_cache_max_gb, 8);
    }
}
