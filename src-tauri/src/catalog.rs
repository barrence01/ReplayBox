use crate::db;
use crate::ffmpeg::{self, ProbeInfo};
use crate::models::Recording;
use crate::settings::{thumbs_dir, Settings};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use uuid::Uuid;
use walkdir::WalkDir;

const VIDEO_EXTS: &[&str] = &["mp4", "mkv", "webm", "mov", "avi", "m4v", "ts"];

pub fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| VIDEO_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// Wait until size is stable so we do not index a file still being written.
pub fn wait_until_stable(path: &Path, checks: u32, delay_ms: u64) -> bool {
    let mut last = 0u64;
    for _ in 0..checks {
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        if size > 0 && size == last {
            return true;
        }
        last = size;
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
    }
    fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false)
}

fn system_time_to_rfc3339(t: SystemTime) -> Option<String> {
    let dt: DateTime<Utc> = t.into();
    Some(dt.to_rfc3339())
}

fn file_times(path: &Path) -> (Option<String>, Option<String>, Option<i64>) {
    match fs::metadata(path) {
        Ok(meta) => {
            let size = Some(meta.len() as i64);
            let modified = meta.modified().ok().and_then(system_time_to_rfc3339);
            let created = meta.created().ok().and_then(system_time_to_rfc3339);
            (created, modified, size)
        }
        Err(_) => (None, None, None),
    }
}

fn thumb_seek_secs(probe: &ProbeInfo) -> f64 {
    match probe.duration_ms {
        Some(ms) if ms > 2000.0 => (ms / 1000.0) * 0.1,
        Some(ms) if ms > 0.0 => (ms / 1000.0) * 0.5,
        _ => 0.0,
    }
}

/// Index or refresh a single recording; optionally attach an active session id.
pub fn index_file(
    conn: &Connection,
    settings: &Settings,
    app_data: &Path,
    path: &Path,
    session_id: Option<&str>,
) -> Result<Recording, String> {
    if !path.is_file() || !is_video_file(path) {
        return Err("Not a video file".into());
    }

    let abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    let abs_str = abs.to_string_lossy().to_string();

    let existing = db::get_recording_by_path(conn, &abs_str)?;
    let id = existing
        .as_ref()
        .map(|r| r.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let probe = ffmpeg::probe(&settings.ffprobe_path, &abs)?;
    let (created_at, modified_at, size_bytes) = file_times(&abs);

    let thumbs = thumbs_dir(app_data);
    fs::create_dir_all(&thumbs).map_err(|e| e.to_string())?;
    let thumb_path = thumbs.join(format!("{id}.jpg"));
    let thumb_str = match ffmpeg::generate_thumbnail(
        &settings.ffmpeg_path,
        &abs,
        &thumb_path,
        thumb_seek_secs(&probe),
    ) {
        Ok(()) => Some(thumb_path.to_string_lossy().to_string()),
        Err(_) => existing.and_then(|r| r.thumbnail_path),
    };

    let filename = abs
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown")
        .to_string();
    let dir = abs
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let rec = Recording {
        id,
        path: abs_str,
        filename,
        dir,
        size_bytes,
        duration_ms: probe.duration_ms,
        width: probe.width,
        height: probe.height,
        video_codec: probe.video_codec,
        audio_codec: probe.audio_codec,
        is_vfr: probe.is_vfr,
        created_at,
        modified_at,
        thumbnail_path: thumb_str,
        session_id: session_id.map(|s| s.to_string()),
        indexed_at: Utc::now().to_rfc3339(),
    };

    db::upsert_recording(conn, &rec)?;
    Ok(rec)
}

/// Full recursive scan of the watch directory into SQLite.
pub fn scan_library(
    conn: &Connection,
    settings: &Settings,
    app_data: &Path,
    session_id: Option<&str>,
) -> Result<usize, String> {
    let root = PathBuf::from(&settings.watch_dir);
    if !root.exists() {
        return Ok(0);
    }

    let mut count = 0usize;
    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() && is_video_file(path) {
            match index_file(conn, settings, app_data, path, session_id) {
                Ok(_) => count += 1,
                Err(e) => eprintln!("index skipped {}: {e}", path.display()),
            }
        }
    }
    Ok(count)
}
