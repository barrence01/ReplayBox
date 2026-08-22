use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Default watch directory for game recordings (user-configurable).
pub const DEFAULT_WATCH_DIR: &str =
    "/run/media/williambarrence/HDD/WilliamBarrence/Gravacoes";

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
}

pub fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join("settings.json")
}

pub fn db_path(app_data: &Path) -> PathBuf {
    app_data.join("replaybox.db")
}

pub fn thumbs_dir(app_data: &Path) -> PathBuf {
    app_data.join("thumbnails")
}

pub fn logs_dir(app_data: &Path) -> PathBuf {
    app_data.join("logs")
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
        settings.save(&path).unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.watch_dir, "/tmp/recordings");
        assert_eq!(loaded.compress_crf, 22);
        assert!(!loaded.prefer_nvenc);
        assert!(loaded.launch_on_startup);
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
              "gameProcessNames": ["cs2"],
              "backgroundServiceEnabled": true
            }"#,
        )
        .unwrap();
        let loaded = Settings::load(&path);
        assert_eq!(loaded.watch_dir, "/videos");
        assert!(!loaded.launch_on_startup);
    }
}
