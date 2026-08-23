use crate::db;
use crate::ffmpeg::{self, ProbeInfo};
use crate::models::Recording;
use crate::settings::{AppPaths, Settings};
use crate::state::AppState;
use chrono::{DateTime, Utc};
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

pub fn normalize_dir(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
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

fn is_unchanged(existing: &Recording, modified_at: &Option<String>, size_bytes: &Option<i64>) -> bool {
    existing.modified_at == *modified_at
        && existing.size_bytes == *size_bytes
        && existing
            .thumbnail_path
            .as_ref()
            .map(|p| Path::new(p).is_file())
            .unwrap_or(false)
}

/// Resolve and validate that `folder_path` lies inside `watch_dir`.
pub fn resolve_folder_in_watch_dir(watch_dir: &str, folder_path: &str) -> Result<PathBuf, String> {
    let watch = PathBuf::from(watch_dir)
        .canonicalize()
        .map_err(|e| format!("Watch folder is not accessible: {e}"))?;
    let folder = PathBuf::from(folder_path)
        .canonicalize()
        .map_err(|e| format!("Folder is not accessible: {e}"))?;

    if !folder.is_dir() {
        return Err("Path is not a directory".into());
    }
    if !folder.starts_with(&watch) {
        return Err("Folder is outside the watch directory".into());
    }
    Ok(folder)
}

/// Index or refresh a single recording.
pub fn index_file(
    conn: &rusqlite::Connection,
    settings: &Settings,
    paths: &AppPaths,
    path: &Path,
) -> Result<Recording, String> {
    if !path.is_file() || !is_video_file(path) {
        return Err("Not a video file".into());
    }

    let abs = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    let abs_str = abs.to_string_lossy().to_string();

    let existing = db::get_recording_by_path(conn, &abs_str)?;
    let (created_at, modified_at, size_bytes) = file_times(&abs);

    if let Some(ref rec) = existing {
        if is_unchanged(rec, &modified_at, &size_bytes) {
            tracing::debug!(path = %abs_str, "skipping unchanged recording");
            return Ok(rec.clone());
        }
    }

    let id = existing
        .as_ref()
        .map(|r| r.id.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let probe = ffmpeg::probe(&settings.ffprobe_path, &abs)?;

    let thumbs = paths.thumbs_dir();
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
        session_id: None,
        indexed_at: Utc::now().to_rfc3339(),
    };

    db::upsert_recording(conn, &rec)?;
    Ok(rec)
}

fn collect_video_paths(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file() && is_video_file(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect()
}

fn index_paths(
    state: &AppState,
    settings: &Settings,
    paths: &[PathBuf],
) -> Result<usize, String> {
    let mut count = 0usize;
    for path in paths {
        let conn = state.db.lock();
        match index_file(&conn, settings, &state.paths, path) {
            Ok(_) => count += 1,
            Err(e) => tracing::warn!(path = %path.display(), error = %e, "index skipped"),
        }
    }
    Ok(count)
}

/// Full recursive scan of the watch directory into SQLite.
pub fn scan_library(state: &AppState, settings: &Settings) -> Result<usize, String> {
    let root = PathBuf::from(&settings.watch_dir);
    if !root.exists() {
        let conn = state.db.lock();
        prune_missing(&conn, &state.paths)?;
        return Ok(0);
    }

    let paths = collect_video_paths(&root);
    let count = index_paths(state, settings, &paths)?;

    let conn = state.db.lock();
    prune_missing(&conn, &state.paths)?;
    Ok(count)
}

/// Scan a single folder subtree under the watch directory.
pub fn scan_folder(
    state: &AppState,
    settings: &Settings,
    folder_path: &str,
) -> Result<usize, String> {
    let folder = resolve_folder_in_watch_dir(&settings.watch_dir, folder_path)?;
    if !folder.exists() {
        let conn = state.db.lock();
        prune_missing_in_folder(&conn, &state.paths, &folder)?;
        return Ok(0);
    }

    let paths = collect_video_paths(&folder);
    let count = index_paths(state, settings, &paths)?;

    let conn = state.db.lock();
    prune_missing_in_folder(&conn, &state.paths, &folder)?;
    Ok(count)
}

/// Drop catalog entries whose files are gone; remove orphan thumbnails.
fn prune_missing(conn: &rusqlite::Connection, paths: &AppPaths) -> Result<(), String> {
    let recordings = db::list_recordings(conn, None)?;
    for rec in recordings {
        if Path::new(&rec.path).exists() {
            continue;
        }
        remove_stale_recording(conn, paths, &rec)?;
    }
    Ok(())
}

fn prune_missing_in_folder(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    folder: &Path,
) -> Result<(), String> {
    let prefix = normalize_dir(&folder.to_string_lossy());
    let recordings = db::list_recordings_under_dir(conn, &prefix)?;
    for rec in recordings {
        if Path::new(&rec.path).exists() {
            continue;
        }
        remove_stale_recording(conn, paths, &rec)?;
    }
    Ok(())
}

fn remove_stale_recording(
    conn: &rusqlite::Connection,
    paths: &AppPaths,
    rec: &Recording,
) -> Result<(), String> {
    let thumb = db::delete_recording_by_id(conn, &rec.id)?;
    if let Some(thumb_path) = thumb.or(rec.thumbnail_path.clone()) {
        let _ = fs::remove_file(&thumb_path);
    }
    let fallback = paths.thumbs_dir().join(format!("{}.jpg", rec.id));
    let _ = fs::remove_file(fallback);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::models::Recording;
    use std::path::PathBuf;

    #[test]
    fn is_video_file_recognizes_supported_extensions() {
        for ext in ["mp4", "MKV", "WebM", "mov", "avi", "m4v", "ts"] {
            let path = PathBuf::from(format!("clip.{ext}"));
            assert!(is_video_file(&path), "expected {ext} to be video");
        }
    }

    #[test]
    fn is_video_file_rejects_non_video() {
        assert!(!is_video_file(Path::new("notes.txt")));
        assert!(!is_video_file(Path::new("clip")));
        assert!(!is_video_file(Path::new("photo.jpg")));
    }

    #[test]
    fn resolve_folder_rejects_outside_watch_dir() {
        let watch = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        assert!(resolve_folder_in_watch_dir(
            watch.path().to_str().unwrap(),
            outside.path().to_str().unwrap()
        )
        .is_err());
    }

    #[test]
    fn list_recordings_under_dir_scopes_to_subtree() {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open_db(&dir.path().join("test.db")).unwrap();

        let game_a = Recording {
            id: "a".into(),
            path: "/watch/GameA/clip.mp4".into(),
            filename: "clip.mp4".into(),
            dir: "/watch/GameA".into(),
            size_bytes: None,
            duration_ms: None,
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
            is_vfr: false,
            created_at: None,
            modified_at: None,
            thumbnail_path: None,
            session_id: None,
            indexed_at: "2024-01-01T00:00:00Z".into(),
        };
        let game_a_nested = Recording {
            dir: "/watch/GameA/sub".into(),
            path: "/watch/GameA/sub/clip2.mp4".into(),
            id: "a2".into(),
            filename: "clip2.mp4".into(),
            size_bytes: None,
            duration_ms: None,
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
            is_vfr: false,
            created_at: None,
            modified_at: None,
            thumbnail_path: None,
            session_id: None,
            indexed_at: "2024-01-01T00:00:00Z".into(),
        };
        let game_b = Recording {
            id: "b".into(),
            path: "/watch/GameB/clip.mp4".into(),
            filename: "clip.mp4".into(),
            dir: "/watch/GameB".into(),
            size_bytes: None,
            duration_ms: None,
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
            is_vfr: false,
            created_at: None,
            modified_at: None,
            thumbnail_path: None,
            session_id: None,
            indexed_at: "2024-01-01T00:00:00Z".into(),
        };

        db::upsert_recording(&conn, &game_a).unwrap();
        db::upsert_recording(&conn, &game_a_nested).unwrap();
        db::upsert_recording(&conn, &game_b).unwrap();

        let under_a = db::list_recordings_under_dir(&conn, "/watch/GameA").unwrap();
        assert_eq!(under_a.len(), 2);
        assert!(under_a.iter().all(|r| r.dir.starts_with("/watch/GameA")));
    }

    #[test]
    fn is_unchanged_detects_matching_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let thumb = dir.path().join("clip.jpg");
        std::fs::write(&thumb, b"x").unwrap();
        let thumb_path = thumb.to_str().unwrap().to_string();

        let rec = Recording {
            id: "r1".into(),
            path: "/videos/clip.mp4".into(),
            filename: "clip.mp4".into(),
            dir: "/videos".into(),
            size_bytes: Some(100),
            duration_ms: Some(1500.0),
            width: None,
            height: None,
            video_codec: None,
            audio_codec: None,
            is_vfr: false,
            created_at: None,
            modified_at: Some("2024-01-02T00:00:00Z".into()),
            thumbnail_path: Some(thumb_path),
            session_id: None,
            indexed_at: "2024-01-03T00:00:00Z".into(),
        };
        assert!(super::is_unchanged(
            &rec,
            &Some("2024-01-02T00:00:00Z".into()),
            &Some(100)
        ));
        assert!(!super::is_unchanged(
            &rec,
            &Some("2024-01-03T00:00:00Z".into()),
            &Some(100)
        ));
    }
}
