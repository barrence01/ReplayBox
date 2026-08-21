use crate::settings::Settings;
use std::path::{Path, PathBuf};

fn is_auto_path(configured: &str, path_fallback: &str) -> bool {
    let t = configured.trim();
    t.is_empty() || t == path_fallback
}

/// Resolve which ffmpeg/ffprobe binary to use.
///
/// Order: absolute/existing override → bundled resource → PATH name.
pub fn resolve_tool_path(
    configured: &str,
    resource_dir: Option<&Path>,
    bundled_name: &str,
    path_fallback: &str,
) -> String {
    let trimmed = configured.trim();

    if !is_auto_path(trimmed, path_fallback) {
        let p = Path::new(trimmed);
        if p.is_file() {
            return trimmed.to_string();
        }
        if crate::ffmpeg::binary_available(trimmed) {
            return trimmed.to_string();
        }
    }

    if let Some(dir) = resource_dir {
        let bundled = dir.join("ffmpeg").join(bundled_name);
        if bundled.is_file() {
            return bundled.to_string_lossy().to_string();
        }
        let flat = dir.join(bundled_name);
        if flat.is_file() {
            return flat.to_string_lossy().to_string();
        }
    }

    path_fallback.to_string()
}

pub fn resolve_ffmpeg(settings: &Settings, resource_dir: Option<&Path>) -> String {
    resolve_tool_path(&settings.ffmpeg_path, resource_dir, "ffmpeg", "ffmpeg")
}

pub fn resolve_ffprobe(settings: &Settings, resource_dir: Option<&Path>) -> String {
    resolve_tool_path(&settings.ffprobe_path, resource_dir, "ffprobe", "ffprobe")
}

/// Prefer Tauri resource_dir; fall back to staged `src-tauri/resources` for dev.
pub fn discover_resource_dir(app_resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = app_resource_dir {
        if dir.join("ffmpeg").join("ffmpeg").is_file()
            || dir.join("ffmpeg").is_file()
            || dir.exists()
        {
            return Some(dir);
        }
    }

    let staging = PathBuf::from("resources/ffmpeg/ffmpeg");
    if staging.is_file() {
        return PathBuf::from("resources").canonicalize().ok();
    }
    let staging = PathBuf::from("src-tauri/resources/ffmpeg/ffmpeg");
    if staging.is_file() {
        return PathBuf::from("src-tauri/resources").canonicalize().ok();
    }
    None
}
