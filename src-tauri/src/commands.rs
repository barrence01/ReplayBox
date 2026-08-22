use crate::catalog;
use crate::db;
use crate::ffmpeg;
use crate::models::{
    CatalogScanFinished, CatalogScanStarted, CompressRequest, CopyPathInfo, JobStatus, Recording,
    TrimRequest,
};
use crate::settings::{self, Settings};
use crate::state::AppState;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_autostart::ManagerExt;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub enum ScanKind {
    Full,
    Folder(String),
}

fn resolved_settings(state: &AppState) -> Result<Settings, String> {
    let mut settings = state.settings.lock().clone();
    settings.ffmpeg_path = state.ffmpeg_bin();
    settings.ffprobe_path = state.ffprobe_bin();
    Ok(settings)
}

fn ensure_ffprobe(settings: &Settings) -> Result<(), String> {
    if !ffmpeg::binary_available(&settings.ffprobe_path) {
        return Err(format!(
            "ffprobe not found at '{}'. Run npm run prepare:ffmpeg or set the path in Settings.",
            settings.ffprobe_path
        ));
    }
    Ok(())
}

/// Spawn a background catalog scan and emit lifecycle events to the frontend.
pub fn spawn_catalog_scan(
    app: AppHandle,
    state: Arc<AppState>,
    kind: ScanKind,
) -> Result<(), String> {
    let settings = resolved_settings(&state)?;
    ensure_ffprobe(&settings)?;

    let (event_kind, folder_path) = match &kind {
        ScanKind::Full => ("full".to_string(), None),
        ScanKind::Folder(path) => ("folder".to_string(), Some(path.clone())),
    };

    {
        let mut scan = state.scan_state.lock();
        match &kind {
            ScanKind::Full => {
                if scan.full {
                    return Err("A library scan is already in progress".into());
                }
                scan.full = true;
            }
            ScanKind::Folder(path) => {
                if scan.full {
                    tracing::debug!(folder = %path, "ignoring folder scan during full rescan");
                    return Ok(());
                }
                let key = catalog::normalize_dir(path);
                if scan.folders.contains(&key) {
                    return Ok(());
                }
                scan.folders.insert(key);
            }
        }
    }

    let started = CatalogScanStarted {
        kind: event_kind.clone(),
        folder_path: folder_path.clone(),
    };
    let _ = app.emit("catalog-scan-started", &started);

    thread::spawn(move || {
        let result = match &kind {
            ScanKind::Full => catalog::scan_library(&state, &settings),
            ScanKind::Folder(path) => catalog::scan_folder(&state, &settings, path),
        };

        {
            let mut scan = state.scan_state.lock();
            match &kind {
                ScanKind::Full => scan.full = false,
                ScanKind::Folder(path) => {
                    scan.folders.remove(&catalog::normalize_dir(path));
                }
            }
        }

        match &result {
            Ok(count) => {
                tracing::info!(kind = %event_kind, count = count, "catalog scan finished");
                let finished = CatalogScanFinished {
                    kind: event_kind.clone(),
                    folder_path: folder_path.clone(),
                    status: "success".into(),
                    count: Some(*count),
                    message: None,
                };
                let _ = app.emit("catalog-scan-finished", &finished);
                let _ = app.emit("catalog-updated", ());
            }
            Err(e) => {
                tracing::error!(kind = %event_kind, error = %e, "catalog scan failed");
                let finished = CatalogScanFinished {
                    kind: event_kind,
                    folder_path,
                    status: "error".into(),
                    count: None,
                    message: Some(e.clone()),
                };
                let _ = app.emit("catalog-scan-finished", &finished);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.settings.lock().clone()
}

/// Check that a path is a readable directory without mutating settings.
#[tauri::command]
pub fn check_watch_dir(path: String) -> Result<(), String> {
    settings::validate_watch_dir(&path)
}

#[tauri::command]
pub fn update_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> Result<Settings, String> {
    settings::validate_watch_dir(&settings.watch_dir)?;
    let path = settings::settings_path(&state.app_data);
    settings.save(&path)?;
    *state.settings.lock() = settings.clone();
    sync_autostart(&app, settings.launch_on_startup)?;
    Ok(settings)
}

fn sync_autostart(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let autostart = app.autolaunch();
    let currently = autostart.is_enabled().map_err(|e| e.to_string())?;
    if enabled && !currently {
        autostart.enable().map_err(|e| e.to_string())?;
    } else if !enabled && currently {
        autostart.disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Apply saved launch-on-startup preference during app setup.
pub fn sync_autostart_on_boot(app: &AppHandle, enabled: bool) -> Result<(), String> {
    sync_autostart(app, enabled)
}

#[tauri::command]
pub fn list_recordings(
    state: State<'_, Arc<AppState>>,
    query: Option<String>,
) -> Result<Vec<Recording>, String> {
    let conn = state.db.lock();
    db::list_recordings(&conn, query.as_deref())
}

#[tauri::command]
pub fn get_recording(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<Recording>, String> {
    let conn = state.db.lock();
    db::get_recording_by_id(&conn, &id)
}

#[tauri::command]
pub fn recording_file_exists(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    let conn = state.db.lock();
    match db::get_recording_by_id(&conn, &id)? {
        Some(rec) => Ok(Path::new(&rec.path).is_file()),
        None => Ok(false),
    }
}

/// Delete a recording file from disk, its thumbnail, and the catalog row.
#[tauri::command]
pub fn delete_recording(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let recording = {
        let conn = state.db.lock();
        db::get_recording_by_id(&conn, &id)?
            .ok_or_else(|| "Recording not found".to_string())?
    };

    let path = Path::new(&recording.path);
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("Failed to delete file: {e}"))?;
    }

    if let Some(ref thumb) = recording.thumbnail_path {
        let thumb_path = Path::new(thumb);
        if thumb_path.exists() {
            let _ = std::fs::remove_file(thumb_path);
        }
    }

    {
        let conn = state.db.lock();
        let _ = db::delete_recording_by_id(&conn, &id)?;
    }

    let _ = app.emit("catalog-updated", ());
    Ok(())
}

/// Default copy destination for a recording (`trimmed` or `compressed`).
#[tauri::command]
pub fn resolve_copy_path(
    state: State<'_, Arc<AppState>>,
    recording_id: String,
    kind: String,
) -> Result<CopyPathInfo, String> {
    let recording = {
        let conn = state.db.lock();
        db::get_recording_by_id(&conn, &recording_id)?
            .ok_or_else(|| "Recording not found".to_string())?
    };
    let kind = match kind.as_str() {
        "compressed" => "compressed",
        _ => "trimmed",
    };
    let dest = ffmpeg::default_copy_dest(Path::new(&recording.path), kind);
    let filename = dest
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("output")
        .to_string();
    let exists = dest.exists();
    Ok(CopyPathInfo {
        path: dest.to_string_lossy().to_string(),
        filename,
        exists,
    })
}

#[tauri::command]
pub fn rescan_library(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    spawn_catalog_scan(app, state.inner().clone(), ScanKind::Full)
}

#[tauri::command]
pub fn scan_folder(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    folder_path: String,
) -> Result<(), String> {
    spawn_catalog_scan(
        app,
        state.inner().clone(),
        ScanKind::Folder(folder_path),
    )
}

#[tauri::command]
pub fn check_tools(state: State<'_, Arc<AppState>>) -> Result<(bool, bool), String> {
    Ok((
        ffmpeg::binary_available(&state.ffmpeg_bin()),
        ffmpeg::binary_available(&state.ffprobe_bin()),
    ))
}

#[tauri::command]
pub fn nvenc_available(state: State<'_, Arc<AppState>>) -> bool {
    ffmpeg::encoder_available(&state.ffmpeg_bin(), "h264_nvenc")
}

#[tauri::command]
pub fn resolved_tool_paths(state: State<'_, Arc<AppState>>) -> (String, String) {
    (state.ffmpeg_bin(), state.ffprobe_bin())
}

#[tauri::command]
pub fn get_media_base_url(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    state
        .media_base_url
        .lock()
        .clone()
        .ok_or_else(|| "Media server is not running".into())
}

#[tauri::command]
pub fn get_job_status(
    state: State<'_, Arc<AppState>>,
    job_id: String,
) -> Option<JobStatus> {
    state.jobs.lock().get(&job_id).cloned()
}

#[tauri::command]
pub fn cancel_job(state: State<'_, Arc<AppState>>, job_id: String) -> Result<(), String> {
    let pid = state
        .job_pids
        .lock()
        .get(&job_id)
        .and_then(|slot| *slot.lock().unwrap());

    if let Some(pid) = pid {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
        if let Some(job) = state.jobs.lock().get_mut(&job_id) {
            job.status = "cancelled".into();
            job.message = Some("Cancelled by user".into());
        }
        Ok(())
    } else {
        Err("No running process for this job".into())
    }
}

#[tauri::command]
pub fn start_trim(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: TrimRequest,
) -> Result<JobStatus, String> {
    let recording = {
        let conn = state.db.lock();
        db::get_recording_by_id(&conn, &request.recording_id)?
            .ok_or_else(|| "Recording not found".to_string())?
    };

    if request.end_ms <= request.start_ms {
        return Err("End time must be after start time".into());
    }

    let settings = {
        let mut s = state.settings.lock().clone();
        s.ffmpeg_path = state.ffmpeg_bin();
        s.ffprobe_path = state.ffprobe_bin();
        s
    };
    if !ffmpeg::binary_available(&settings.ffmpeg_path) {
        return Err(format!(
            "ffmpeg not found at '{}'. Run npm run prepare:ffmpeg or set the path in Settings.",
            settings.ffmpeg_path
        ));
    }

    let dest = ffmpeg::resolve_job_dest(
        Path::new(&recording.path),
        &request.output_mode,
        "trimmed",
        true,
        request.copy_collision.as_deref(),
    );

    let job_id = Uuid::new_v4().to_string();
    let job = JobStatus {
        id: job_id.clone(),
        kind: "trim".into(),
        status: "running".into(),
        progress: 0.0,
        message: Some(format!("Trim ({})", request.mode)),
        output_path: Some(dest.to_string_lossy().to_string()),
    };
    state.jobs.lock().insert(job_id.clone(), job.clone());

    let child_slot = Arc::new(Mutex::new(None));
    state
        .job_pids
        .lock()
        .insert(job_id.clone(), child_slot.clone());

    let state_arc = state.inner().clone();
    let on_progress = make_progress_emitter(app.clone(), state_arc.clone(), job_id.clone());
    thread::spawn(move || {
        let result = run_trim(
            &settings,
            &recording,
            &request,
            &dest,
            Some(child_slot),
            Some(on_progress),
        );
        finalize_job(&app, &state_arc, &job_id, result, &recording.path);
    });

    Ok(job)
}

#[tauri::command]
pub fn start_compress(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: CompressRequest,
) -> Result<JobStatus, String> {
    let recording = {
        let conn = state.db.lock();
        db::get_recording_by_id(&conn, &request.recording_id)?
            .ok_or_else(|| "Recording not found".to_string())?
    };

    let settings = {
        let mut s = state.settings.lock().clone();
        s.ffmpeg_path = state.ffmpeg_bin();
        s.ffprobe_path = state.ffprobe_bin();
        s
    };
    if !ffmpeg::binary_available(&settings.ffmpeg_path) {
        return Err(format!(
            "ffmpeg not found at '{}'. Run npm run prepare:ffmpeg or set the path in Settings.",
            settings.ffmpeg_path
        ));
    }

    let dest = ffmpeg::resolve_job_dest(
        Path::new(&recording.path),
        &request.output_mode,
        "compressed",
        true,
        request.copy_collision.as_deref(),
    );

    let job_id = Uuid::new_v4().to_string();
    let job = JobStatus {
        id: job_id.clone(),
        kind: "compress".into(),
        status: "running".into(),
        progress: 0.0,
        message: Some("Compressing".into()),
        output_path: Some(dest.to_string_lossy().to_string()),
    };
    state.jobs.lock().insert(job_id.clone(), job.clone());

    let child_slot = Arc::new(Mutex::new(None));
    state
        .job_pids
        .lock()
        .insert(job_id.clone(), child_slot.clone());

    let state_arc = state.inner().clone();
    let on_progress = make_progress_emitter(app.clone(), state_arc.clone(), job_id.clone());
    thread::spawn(move || {
        let result = run_compress(
            &settings,
            &recording,
            &request,
            &dest,
            Some(child_slot),
            Some(on_progress),
        );
        finalize_job(&app, &state_arc, &job_id, result, &recording.path);
    });

    Ok(job)
}

fn make_progress_emitter(
    app: AppHandle,
    state: Arc<AppState>,
    job_id: String,
) -> ffmpeg::ProgressFn {
    Arc::new(move |fraction: f64| {
        let mut jobs = state.jobs.lock();
        if let Some(job) = jobs.get_mut(&job_id) {
            if job.status != "running" {
                return;
            }
            job.progress = fraction;
            let _ = app.emit("job-progress", job.clone());
        }
    })
}

fn run_trim(
    settings: &Settings,
    recording: &Recording,
    request: &TrimRequest,
    dest: &Path,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
    on_progress: Option<ffmpeg::ProgressFn>,
) -> Result<PathBuf, String> {
    let input = Path::new(&recording.path);
    let start = request.start_ms / 1000.0;
    let end = request.end_ms / 1000.0;

    let temp = ffmpeg::sibling_output_with_ext(input, "tmp_edit", "mp4");
    match request.mode.as_str() {
        "fast" => {
            ffmpeg::fast_trim(
                &settings.ffmpeg_path,
                input,
                &temp,
                start,
                end,
                child_slot,
                on_progress,
            )?
        }
        _ => {
            ffmpeg::precise_trim(
                &settings.ffmpeg_path,
                input,
                &temp,
                start,
                end,
                child_slot,
                on_progress,
            )?
        }
    }

    finish_output(input, &temp, &request.output_mode, dest)
}

fn run_compress(
    settings: &Settings,
    recording: &Recording,
    request: &CompressRequest,
    dest: &Path,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
    on_progress: Option<ffmpeg::ProgressFn>,
) -> Result<PathBuf, String> {
    let input = Path::new(&recording.path);
    let crf = request.crf.unwrap_or(settings.compress_crf);
    let use_nvenc = request.use_nvenc.unwrap_or(settings.prefer_nvenc);
    let fps = request.fps.unwrap_or(60);
    let duration_secs = recording
        .duration_ms
        .map(|ms| (ms / 1000.0).max(0.001))
        .unwrap_or(1.0);

    let temp = ffmpeg::sibling_output_with_ext(input, "tmp_compress", "mp4");
    ffmpeg::compress(
        &settings.ffmpeg_path,
        input,
        &temp,
        crf,
        use_nvenc,
        fps,
        duration_secs,
        child_slot,
        on_progress,
    )?;
    finish_output(input, &temp, &request.output_mode, dest)
}

fn finish_output(
    original: &Path,
    temp: &Path,
    output_mode: &str,
    dest: &Path,
) -> Result<PathBuf, String> {
    if output_mode == "replace" {
        if dest == original {
            ffmpeg::atomic_replace(temp, original)?;
            Ok(original.to_path_buf())
        } else {
            if dest.exists() && dest != temp {
                std::fs::remove_file(dest).map_err(|e| e.to_string())?;
            }
            std::fs::rename(temp, dest).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(original);
            Ok(dest.to_path_buf())
        }
    } else {
        if dest.exists() {
            std::fs::remove_file(dest).map_err(|e| e.to_string())?;
        }
        std::fs::rename(temp, dest).map_err(|e| e.to_string())?;
        Ok(dest.to_path_buf())
    }
}

fn finalize_job(
    app: &AppHandle,
    state: &AppState,
    job_id: &str,
    result: Result<PathBuf, String>,
    original_path: &str,
) {
    state.job_pids.lock().remove(job_id);

    let mut jobs = state.jobs.lock();
    if let Some(job) = jobs.get_mut(job_id) {
        if job.status == "cancelled" {
            let _ = app.emit("job-progress", job.clone());
            return;
        }
        match result {
            Ok(path) => {
                job.status = "done".into();
                job.progress = 1.0;
                job.output_path = Some(path.to_string_lossy().to_string());
                job.message = Some("Completed".into());

                let mut settings = state.settings.lock().clone();
                settings.ffmpeg_path = state.ffmpeg_bin();
                settings.ffprobe_path = state.ffprobe_bin();
                let conn = state.db.lock();

                if path.to_string_lossy() != original_path
                    && !Path::new(original_path).exists()
                {
                    let _ = db::delete_recording_by_path(&conn, original_path);
                }

                let _ = catalog::index_file(&conn, &settings, &state.app_data, &path);
            }
            Err(e) => {
                job.status = "error".into();
                job.message = Some(e);
            }
        }
        let _ = app.emit("job-progress", job.clone());
        let _ = app.emit("catalog-updated", ());
    }
}
