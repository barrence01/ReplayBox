use crate::catalog;
use crate::db;
use crate::ffmpeg;
use crate::models::{CompressRequest, JobStatus, Recording, Session, TrimRequest};
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::watcher;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Settings {
    state.settings.lock().clone()
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, Arc<AppState>>,
    settings: Settings,
) -> Result<Settings, String> {
    let path = settings::settings_path(&state.app_data);
    settings.save(&path)?;
    *state.settings.lock() = settings.clone();
    let _ = watcher::rewatch(&state);
    Ok(settings)
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
pub fn list_session_recordings(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<Vec<Recording>, String> {
    let conn = state.db.lock();
    db::list_session_recordings(&conn, &session_id)
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
pub fn get_active_session(state: State<'_, Arc<AppState>>) -> Option<Session> {
    state.active_session.lock().as_ref().map(|s| Session {
        id: s.id.clone(),
        started_at: String::new(),
        ended_at: None,
        game_process: Some(s.game_process.clone()),
    })
}

#[tauri::command]
pub fn rescan_library(state: State<'_, Arc<AppState>>) -> Result<usize, String> {
    let settings = {
        let mut s = state.settings.lock().clone();
        s.ffmpeg_path = state.ffmpeg_bin();
        s.ffprobe_path = state.ffprobe_bin();
        s
    };
    if !ffmpeg::binary_available(&settings.ffprobe_path) {
        return Err(format!(
            "ffprobe not found at '{}'. Run npm run prepare:ffmpeg or set the path in Settings.",
            settings.ffprobe_path
        ));
    }
    let session_id = state
        .active_session
        .lock()
        .as_ref()
        .map(|s| s.id.clone());
    let conn = state.db.lock();
    catalog::scan_library(
        &conn,
        &settings,
        &state.app_data,
        session_id.as_deref(),
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

    let job_id = Uuid::new_v4().to_string();
    let job = JobStatus {
        id: job_id.clone(),
        kind: "trim".into(),
        status: "running".into(),
        progress: 0.0,
        message: Some(format!("Trim ({})", request.mode)),
        output_path: None,
    };
    state.jobs.lock().insert(job_id.clone(), job.clone());

    let child_slot = Arc::new(Mutex::new(None));
    state
        .job_pids
        .lock()
        .insert(job_id.clone(), child_slot.clone());

    let state_arc = state.inner().clone();
    thread::spawn(move || {
        let result = run_trim(&settings, &recording, &request, Some(child_slot));
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

    let job_id = Uuid::new_v4().to_string();
    let job = JobStatus {
        id: job_id.clone(),
        kind: "compress".into(),
        status: "running".into(),
        progress: 0.0,
        message: Some("Compressing".into()),
        output_path: None,
    };
    state.jobs.lock().insert(job_id.clone(), job.clone());

    let child_slot = Arc::new(Mutex::new(None));
    state
        .job_pids
        .lock()
        .insert(job_id.clone(), child_slot.clone());

    let state_arc = state.inner().clone();
    thread::spawn(move || {
        let result = run_compress(&settings, &recording, &request, Some(child_slot));
        finalize_job(&app, &state_arc, &job_id, result, &recording.path);
    });

    Ok(job)
}

fn run_trim(
    settings: &Settings,
    recording: &Recording,
    request: &TrimRequest,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<PathBuf, String> {
    let input = Path::new(&recording.path);
    let start = request.start_ms / 1000.0;
    let end = request.end_ms / 1000.0;

    let temp = ffmpeg::sibling_output(input, "tmp_edit");
    match request.mode.as_str() {
        "fast" => {
            ffmpeg::fast_trim(&settings.ffmpeg_path, input, &temp, start, end, child_slot)?
        }
        _ => {
            ffmpeg::precise_trim(&settings.ffmpeg_path, input, &temp, start, end, child_slot)?
        }
    }

    finish_output(input, &temp, &request.output_mode, "trimmed")
}

fn run_compress(
    settings: &Settings,
    recording: &Recording,
    request: &CompressRequest,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
) -> Result<PathBuf, String> {
    let input = Path::new(&recording.path);
    let crf = request.crf.unwrap_or(settings.compress_crf);
    let use_nvenc = request.use_nvenc.unwrap_or(settings.prefer_nvenc);
    let temp = ffmpeg::sibling_output(input, "tmp_compress");
    ffmpeg::compress(
        &settings.ffmpeg_path,
        input,
        &temp,
        crf,
        use_nvenc,
        child_slot,
    )?;
    finish_output(input, &temp, &request.output_mode, "compressed")
}

fn finish_output(
    original: &Path,
    temp: &Path,
    output_mode: &str,
    suffix: &str,
) -> Result<PathBuf, String> {
    if output_mode == "replace" {
        ffmpeg::atomic_replace(temp, original)?;
        Ok(original.to_path_buf())
    } else {
        let dest = ffmpeg::sibling_output(original, suffix);
        if dest.exists() {
            std::fs::remove_file(&dest).map_err(|e| e.to_string())?;
        }
        std::fs::rename(temp, &dest).map_err(|e| e.to_string())?;
        Ok(dest)
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
                let session_id = state
                    .active_session
                    .lock()
                    .as_ref()
                    .map(|s| s.id.clone());
                let conn = state.db.lock();
                let _ = catalog::index_file(
                    &conn,
                    &settings,
                    &state.app_data,
                    &path,
                    session_id.as_deref(),
                );
                if path.to_string_lossy() == original_path {
                    let _ = catalog::index_file(
                        &conn,
                        &settings,
                        &state.app_data,
                        Path::new(original_path),
                        session_id.as_deref(),
                    );
                }
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
