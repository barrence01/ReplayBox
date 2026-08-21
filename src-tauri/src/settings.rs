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
    /// Process names (comm / cmdline substrings) that mark an active game session.
    pub game_process_names: Vec<String>,
    pub compress_crf: u8,
    pub prefer_nvenc: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            watch_dir: DEFAULT_WATCH_DIR.to_string(),
            // Empty → auto-resolve to bundled resources, then PATH.
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            game_process_names: Vec::new(),
            compress_crf: 26,
            prefer_nvenc: true,
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
