use crate::logging::{append_ffmpeg_log_bytes, flush_ffmpeg_log};
use crate::models::Recording;
use crate::playback::PlaybackStrategy;
use crate::settings::Settings;
use crate::state::AppState;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_ATTEMPTS_PER_STRATEGY: u8 = 1;
const JOB_STALE_TIMEOUT: Duration = Duration::from_secs(180);
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);
/// Shorter GOP (~250ms @ 60fps) for scrub-friendly transcode previews.
const SCRUB_PREVIEW_GOP: &str = "15";

#[derive(Debug, Clone, Copy)]
pub struct CleanupPolicy {
    pub ttl: Duration,
    pub max_bytes: u64,
}

impl CleanupPolicy {
    pub fn from_settings(settings: &Settings) -> Self {
        Self {
            ttl: CACHE_TTL,
            max_bytes: settings.playback_cache_max_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheSidecar {
    source_mtime: u64,
    source_size: u64,
    strategy: String,
    created_at: String,
}

#[derive(Debug, Clone)]
pub enum CacheJobStatus {
    Preparing,
    Ready { path: PathBuf },
    Failed { message: String },
}

pub(crate) struct CacheJobEntry {
    strategy: PlaybackStrategy,
    status: CacheJobStatus,
    attempts: u8,
    started_at: Instant,
    failed_at: Option<Instant>,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

pub type PlaybackCacheJobs = Arc<Mutex<HashMap<String, CacheJobEntry>>>;

pub fn new_playback_cache_jobs() -> PlaybackCacheJobs {
    Arc::new(Mutex::new(HashMap::new()))
}

pub fn cache_file_path(cache_dir: &Path, recording_id: &str) -> PathBuf {
    cache_dir.join(format!("{recording_id}.mp4"))
}

pub fn cache_temp_path(output: &Path) -> PathBuf {
    let parent = output.parent().unwrap_or_else(|| Path::new("."));
    let stem = output
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("cache");
    parent.join(format!("{stem}.partial.mp4"))
}

fn is_final_cache_mp4(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("mp4")
        && path
            .file_stem()
            .and_then(|s| s.to_str())
            .is_some_and(|s| !s.ends_with(".partial"))
}

fn sidecar_path(cache_dir: &Path, recording_id: &str) -> PathBuf {
    cache_dir.join(format!("{recording_id}.json"))
}

fn strategy_sidecar_name(strategy: PlaybackStrategy) -> &'static str {
    match strategy {
        PlaybackStrategy::Direct => "direct",
        PlaybackStrategy::RemuxAudio => "remux",
        PlaybackStrategy::Transcode => "transcode",
    }
}

fn strategy_rank(strategy: PlaybackStrategy) -> u8 {
    match strategy {
        PlaybackStrategy::Direct => 0,
        PlaybackStrategy::RemuxAudio => 1,
        PlaybackStrategy::Transcode => 2,
    }
}

fn sidecar_strategy_rank(name: &str) -> u8 {
    match name {
        "transcode" => 2,
        "remux" => 1,
        _ => 0,
    }
}

fn failure_cooldown_elapsed(failed_at: Option<Instant>) -> bool {
    failed_at.is_some_and(|t| t.elapsed() >= FAILURE_COOLDOWN)
}

pub fn source_metadata(path: &Path) -> Result<(u64, u64), String> {
    let meta = fs::metadata(path).map_err(|e| format!("source metadata: {e}"))?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(system_time_to_secs)
        .unwrap_or(0);
    Ok((mtime, size))
}

fn system_time_to_secs(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs())
}

fn read_sidecar(path: &Path) -> Option<CacheSidecar> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn is_cache_valid(
    cache_dir: &Path,
    recording_id: &str,
    source_path: &Path,
    required_strategy: PlaybackStrategy,
) -> Option<PathBuf> {
    let cache_path = cache_file_path(cache_dir, recording_id);
    if !cache_path.is_file() {
        return None;
    }

    let sidecar = read_sidecar(&sidecar_path(cache_dir, recording_id))?;
    let (mtime, size) = source_metadata(source_path).ok()?;
    if sidecar.source_mtime != mtime || sidecar.source_size != size {
        return None;
    }
    if sidecar_strategy_rank(&sidecar.strategy) < strategy_rank(required_strategy) {
        return None;
    }

    Some(cache_path)
}

fn write_sidecar(
    cache_dir: &Path,
    recording_id: &str,
    mtime: u64,
    size: u64,
    strategy: PlaybackStrategy,
) -> Result<(), String> {
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let sidecar = CacheSidecar {
        source_mtime: mtime,
        source_size: size,
        strategy: strategy_sidecar_name(strategy).to_string(),
        created_at: Utc::now().to_rfc3339(),
    };
    let raw = serde_json::to_string_pretty(&sidecar).map_err(|e| e.to_string())?;
    fs::write(sidecar_path(cache_dir, recording_id), raw).map_err(|e| e.to_string())
}

pub fn audio_copy_compatible(audio_codec: Option<&str>) -> bool {
    match audio_codec.map(str::to_ascii_lowercase).as_deref() {
        Some("aac") | Some("mp3") | Some("mp4a") => true,
        None => true,
        _ => false,
    }
}

fn spawn_stderr_reader(stderr: std::process::ChildStderr) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => append_ffmpeg_log_bytes(&buf[..n]),
                Err(_) => break,
            }
        }
        flush_ffmpeg_log();
    });
}

fn kill_child(child_slot: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = child_slot.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn run_ffmpeg_cache(
    ffmpeg: &str,
    input: &Path,
    output: &Path,
    strategy: PlaybackStrategy,
    audio_codec: Option<&str>,
    cancel: &AtomicBool,
    child_slot: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    let tmp = cache_temp_path(output);
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }

    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y"]);
    cmd.arg("-i").arg(input);

    match strategy {
        PlaybackStrategy::Direct => return Err("direct does not use cache ffmpeg".into()),
        PlaybackStrategy::RemuxAudio => {
            cmd.args(["-c:v", "copy"]);
            if audio_copy_compatible(audio_codec) {
                cmd.args(["-c:a", "copy"]);
            } else {
                cmd.args(["-c:a", "aac", "-b:a", "128k"]);
            }
            cmd.args(["-avoid_negative_ts", "make_zero", "-fflags", "+genpts"]);
        }
        PlaybackStrategy::Transcode => {
            cmd.args([
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "23",
                "-fps_mode",
                "cfr",
                "-r",
                "60",
                "-g",
                SCRUB_PREVIEW_GOP,
                "-keyint_min",
                SCRUB_PREVIEW_GOP,
                "-c:a",
                "aac",
                "-b:a",
                "128k",
            ]);
        }
    }

    cmd.args([
        "-f",
        "mp4",
        "-movflags",
        "+faststart",
        tmp.to_str().unwrap_or(""),
    ]);
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg cache job: {e}"))?;

    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_reader(stderr);
    }

    *child_slot.lock().expect("cache child lock") = Some(child);

    loop {
        if cancel.load(Ordering::Relaxed) {
            kill_child(child_slot);
            let _ = fs::remove_file(&tmp);
            return Err("Cache job cancelled".into());
        }

        let finished = {
            let mut guard = child_slot.lock().expect("cache child lock");
            if let Some(child) = guard.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        guard.take();
                        if status.success() {
                            Ok(true)
                        } else {
                            Err(format!("ffmpeg cache exited with {status}"))
                        }
                    }
                    Ok(None) => Ok(false),
                    Err(e) => Err(format!("ffmpeg wait failed: {e}")),
                }
            } else {
                Err("ffmpeg child missing".into())
            }
        };

        match finished {
            Ok(true) => break,
            Ok(false) => thread::sleep(Duration::from_millis(200)),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
        }
    }

    if cancel.load(Ordering::Relaxed) {
        let _ = fs::remove_file(&tmp);
        return Err("Cache job cancelled".into());
    }

    if output.exists() {
        fs::remove_file(output).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, output).map_err(|e| format!("cache rename failed: {e}"))?;
    Ok(())
}

fn mark_entry_failed(entry: &mut CacheJobEntry, message: String) -> CacheJobStatus {
    cancel_job_entry(entry);
    entry.failed_at = Some(Instant::now());
    entry.status = CacheJobStatus::Failed {
        message: message.clone(),
    };
    CacheJobStatus::Failed { message }
}

fn resolve_existing_job(
    entry: &mut CacheJobEntry,
    strategy: PlaybackStrategy,
) -> Option<CacheJobStatus> {
    match &entry.status {
        CacheJobStatus::Ready { path } => Some(CacheJobStatus::Ready { path: path.clone() }),
        CacheJobStatus::Preparing if entry.strategy == strategy => {
            if entry.started_at.elapsed() > JOB_STALE_TIMEOUT {
                Some(mark_entry_failed(
                    entry,
                    "Preview preparation timed out".into(),
                ))
            } else {
                Some(CacheJobStatus::Preparing)
            }
        }
        CacheJobStatus::Failed { message } if entry.strategy == strategy => {
            if failure_cooldown_elapsed(entry.failed_at) {
                None
            } else {
                Some(CacheJobStatus::Failed {
                    message: message.clone(),
                })
            }
        }
        CacheJobStatus::Failed { .. } | CacheJobStatus::Preparing => {
            if strategy_rank(strategy) > strategy_rank(entry.strategy) {
                None
            } else if let CacheJobStatus::Failed { message } = &entry.status {
                Some(CacheJobStatus::Failed {
                    message: message.clone(),
                })
            } else {
                Some(CacheJobStatus::Preparing)
            }
        }
    }
}

pub fn ensure_cache_job(
    state: &AppState,
    recording: &Recording,
    strategy: PlaybackStrategy,
) -> CacheJobStatus {
    if strategy == PlaybackStrategy::Direct {
        return CacheJobStatus::Failed {
            message: "direct strategy does not use cache".into(),
        };
    }

    if state.settings.lock().playback_cache_max_gb == 0 {
        return CacheJobStatus::Failed {
            message: "Preview cache is disabled due to insufficient disk space.".into(),
        };
    }

    let cache_dir = state.paths.playback_cache_dir();
    let source = Path::new(&recording.path);

    if let Some(path) = is_cache_valid(&cache_dir, &recording.id, source, strategy) {
        return CacheJobStatus::Ready { path };
    }

    let mut jobs = state.playback_cache_jobs.lock().expect("playback cache jobs lock");
    if let Some(entry) = jobs.get_mut(&recording.id) {
        match resolve_existing_job(entry, strategy) {
            Some(status) => return status,
            None => {
                cancel_job_entry(entry);
                jobs.remove(&recording.id);
            }
        }
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let child_slot = Arc::new(Mutex::new(None));
    jobs.insert(
        recording.id.clone(),
        CacheJobEntry {
            strategy,
            status: CacheJobStatus::Preparing,
            attempts: 1,
            started_at: Instant::now(),
            failed_at: None,
            cancel: cancel.clone(),
            child: child_slot.clone(),
        },
    );
    drop(jobs);

    let recording_id = recording.id.clone();
    let recording_path = recording.path.clone();
    let audio_codec = recording.audio_codec.clone();
    let ffmpeg = state.ffmpeg_bin();
    let jobs_handle = state.playback_cache_jobs.clone();
    let paths = state.paths.clone();
    let cleanup_policy = CleanupPolicy::from_settings(&state.settings.lock());
    let output_path = cache_file_path(&cache_dir, &recording_id);

    tracing::info!(
        recording_id = %recording_id,
        strategy = ?strategy,
        attempt = 1,
        max_attempts = MAX_ATTEMPTS_PER_STRATEGY,
        input = %recording_path,
        output = %output_path.display(),
        "playback cache job started"
    );

    let job_started = Instant::now();
    thread::spawn(move || {
        let cache_dir = paths.playback_cache_dir();
        let output = cache_file_path(&cache_dir, &recording_id);
        let input = PathBuf::from(&recording_path);

        let result = run_ffmpeg_cache(
            &ffmpeg,
            &input,
            &output,
            strategy,
            audio_codec.as_deref(),
            &cancel,
            &child_slot,
        );

        let mut jobs = jobs_handle.lock().expect("playback cache jobs lock");
        let Some(entry) = jobs.get_mut(&recording_id) else {
            return;
        };

        let elapsed_ms = job_started.elapsed().as_millis();
        entry.status = match result {
            Ok(()) => {
                tracing::info!(
                    recording_id = %recording_id,
                    duration_ms = elapsed_ms,
                    "playback cache job ready"
                );
                if let Ok((mtime, size)) = source_metadata(&input) {
                    let _ = write_sidecar(&cache_dir, &recording_id, mtime, size, strategy);
                }
                run_cache_cleanup(&cache_dir, &cleanup_policy);
                CacheJobStatus::Ready { path: output }
            }
            Err(e) => {
                tracing::error!(
                    recording_id = %recording_id,
                    strategy = ?strategy,
                    duration_ms = elapsed_ms,
                    attempt = entry.attempts,
                    error = %e,
                    "playback cache job failed; see ffmpeg.log for stderr"
                );
                let _ = fs::remove_file(&output);
                let _ = fs::remove_file(cache_temp_path(&output));
                let _ = fs::remove_file(sidecar_path(&cache_dir, &recording_id));
                entry.failed_at = Some(Instant::now());
                CacheJobStatus::Failed { message: e }
            }
        };
    });

    CacheJobStatus::Preparing
}

fn cancel_job_entry(entry: &CacheJobEntry) {
    entry.cancel.store(true, Ordering::Relaxed);
    kill_child(&entry.child);
}

pub fn cancel_all_cache_jobs(jobs: &PlaybackCacheJobs) {
    let mut guard = jobs.lock().expect("playback cache jobs lock");
    for (_, entry) in guard.iter() {
        cancel_job_entry(entry);
    }
    guard.clear();
}

fn is_cache_storage_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    if ext == "json" {
        return true;
    }
    ext == "mp4"
}

fn cache_file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn playback_cache_used_bytes(cache_dir: &Path) -> u64 {
    let Ok(read_dir) = fs::read_dir(cache_dir) else {
        return 0;
    };

    read_dir
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("mp4") {
                return None;
            }
            Some(cache_file_size(&path))
        })
        .sum()
}

pub fn clear_playback_cache_dir(cache_dir: &Path) -> Result<u64, String> {
    if fs::create_dir_all(cache_dir).is_err() {
        return Ok(0);
    }

    let Ok(read_dir) = fs::read_dir(cache_dir) else {
        return Ok(0);
    };

    let mut freed = 0u64;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !is_cache_storage_file(&path) {
            continue;
        }
        freed += cache_file_size(&path);
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(freed)
}

pub fn clear_thumbnails_dir(thumbs_dir: &Path) -> Result<u64, String> {
    if fs::create_dir_all(thumbs_dir).is_err() {
        return Ok(0);
    }

    let Ok(read_dir) = fs::read_dir(thumbs_dir) else {
        return Ok(0);
    };

    let mut freed = 0u64;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        freed += cache_file_size(&path);
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(freed)
}

struct CacheEntryInfo {
    path: PathBuf,
    sidecar_path: PathBuf,
    size: u64,
    created_at: DateTime<Utc>,
}

pub fn run_cache_cleanup(cache_dir: &Path, policy: &CleanupPolicy) {
    if fs::create_dir_all(cache_dir).is_err() {
        return;
    }

    let now = Utc::now();
    let mut entries: Vec<CacheEntryInfo> = Vec::new();

    let Ok(read_dir) = fs::read_dir(cache_dir) else {
        return;
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if !is_final_cache_mp4(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let sidecar = sidecar_path(cache_dir, stem);
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let size = meta.len();
        let created_at = read_sidecar(&sidecar)
            .and_then(|s| DateTime::parse_from_rfc3339(&s.created_at).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|| {
                meta.modified()
                    .ok()
                    .and_then(|t| {
                        t.duration_since(UNIX_EPOCH)
                            .ok()
                            .map(|d| DateTime::from_timestamp(d.as_secs() as i64, 0))
                    })
                    .flatten()
                    .unwrap_or(now)
            });

        if now.signed_duration_since(created_at).to_std().unwrap_or(Duration::ZERO) > policy.ttl
        {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(&sidecar);
            continue;
        }

        entries.push(CacheEntryInfo {
            path,
            sidecar_path: sidecar,
            size,
            created_at,
        });
    }

    let total: u64 = entries.iter().map(|e| e.size).sum();
    if total <= policy.max_bytes {
        return;
    }

    entries.sort_by_key(|e| e.created_at);
    let mut freed = 0u64;
    let need_free = total.saturating_sub(policy.max_bytes);
    for entry in entries {
        if freed >= need_free {
            break;
        }
        if fs::remove_file(&entry.path).is_ok() {
            let _ = fs::remove_file(&entry.sidecar_path);
            freed += entry.size;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn cache_temp_path_ends_with_mp4_for_ffmpeg() {
        let output = PathBuf::from("/cache/rec-1.mp4");
        let tmp = cache_temp_path(&output);
        assert_eq!(tmp.extension().and_then(|e| e.to_str()), Some("mp4"));
    }

    #[test]
    fn cache_temp_path_uses_partial_mp4_extension() {
        let output = PathBuf::from("/cache/rec-1.mp4");
        assert_eq!(
            cache_temp_path(&output),
            PathBuf::from("/cache/rec-1.partial.mp4")
        );
    }

    #[test]
    fn audio_copy_compatible_accepts_aac_mp3() {
        assert!(audio_copy_compatible(Some("aac")));
        assert!(audio_copy_compatible(Some("MP3")));
        assert!(!audio_copy_compatible(Some("opus")));
    }

    #[test]
    fn failed_sticky_without_cooldown() {
        let mut entry = CacheJobEntry {
            strategy: PlaybackStrategy::RemuxAudio,
            status: CacheJobStatus::Failed {
                message: "boom".into(),
            },
            attempts: 1,
            started_at: Instant::now(),
            failed_at: Some(Instant::now()),
            cancel: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        };
        let resolved = resolve_existing_job(&mut entry, PlaybackStrategy::RemuxAudio);
        assert!(matches!(resolved, Some(CacheJobStatus::Failed { .. })));
    }

    #[test]
    fn failed_allows_retry_after_cooldown() {
        let mut entry = CacheJobEntry {
            strategy: PlaybackStrategy::RemuxAudio,
            status: CacheJobStatus::Failed {
                message: "boom".into(),
            },
            attempts: 1,
            started_at: Instant::now(),
            failed_at: Some(Instant::now() - FAILURE_COOLDOWN - Duration::from_secs(1)),
            cancel: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        };
        assert!(resolve_existing_job(&mut entry, PlaybackStrategy::RemuxAudio).is_none());
    }

    #[test]
    fn preparing_stale_becomes_failed() {
        let mut entry = CacheJobEntry {
            strategy: PlaybackStrategy::RemuxAudio,
            status: CacheJobStatus::Preparing,
            attempts: 1,
            started_at: Instant::now() - JOB_STALE_TIMEOUT - Duration::from_secs(1),
            failed_at: None,
            cancel: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
        };
        let resolved = resolve_existing_job(&mut entry, PlaybackStrategy::RemuxAudio);
        assert!(matches!(resolved, Some(CacheJobStatus::Failed { .. })));
    }

    #[test]
    fn cache_valid_when_sidecar_matches_source() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        let source = tmp.path().join("source.mp4");
        fs::write(&source, b"source-bytes").unwrap();
        let (mtime, size) = source_metadata(&source).unwrap();

        let id = "rec-1";
        let cache_path = cache_file_path(&cache_dir, id);
        fs::write(&cache_path, b"cached").unwrap();
        write_sidecar(&cache_dir, id, mtime, size, PlaybackStrategy::RemuxAudio).unwrap();

        assert!(is_cache_valid(&cache_dir, id, &source, PlaybackStrategy::RemuxAudio).is_some());
    }

    #[test]
    fn cache_invalid_when_source_mtime_changes() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        let source = tmp.path().join("source.mp4");
        fs::write(&source, b"v1").unwrap();
        let (mtime, size) = source_metadata(&source).unwrap();

        let id = "rec-1";
        fs::write(cache_file_path(&cache_dir, id), b"cached").unwrap();
        write_sidecar(&cache_dir, id, mtime, size, PlaybackStrategy::RemuxAudio).unwrap();

        let mut file = fs::OpenOptions::new().append(true).open(&source).unwrap();
        file.write_all(b"v2").unwrap();

        assert!(is_cache_valid(&cache_dir, id, &source, PlaybackStrategy::RemuxAudio).is_none());
    }

    #[test]
    fn remux_cache_insufficient_for_transcode_requirement() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        let source = tmp.path().join("source.mp4");
        fs::write(&source, b"source").unwrap();
        let (mtime, size) = source_metadata(&source).unwrap();

        let id = "rec-1";
        fs::write(cache_file_path(&cache_dir, id), b"cached").unwrap();
        write_sidecar(&cache_dir, id, mtime, size, PlaybackStrategy::RemuxAudio).unwrap();

        assert!(is_cache_valid(&cache_dir, id, &source, PlaybackStrategy::Transcode).is_none());
    }

    #[test]
    fn ttl_cleanup_removes_expired_entries() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        let id = "old";
        fs::write(cache_file_path(&cache_dir, id), b"cached").unwrap();
        let sidecar = CacheSidecar {
            source_mtime: 1,
            source_size: 1,
            strategy: "remux".into(),
            created_at: "2020-01-01T00:00:00Z".into(),
        };
        fs::write(
            sidecar_path(&cache_dir, id),
            serde_json::to_string(&sidecar).unwrap(),
        )
        .unwrap();

        run_cache_cleanup(&cache_dir, &CleanupPolicy::from_settings(&Settings::default()));
        assert!(!cache_file_path(&cache_dir, id).exists());
    }

    #[test]
    fn lru_cleanup_respects_policy_max_bytes() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        let policy = CleanupPolicy {
            ttl: CACHE_TTL,
            max_bytes: 2048,
        };
        let recent = Utc::now().to_rfc3339();
        let slightly_older = (Utc::now() - chrono::Duration::hours(1)).to_rfc3339();

        for (id, created_at) in [("old", slightly_older), ("new", recent)] {
            let path = cache_file_path(&cache_dir, id);
            fs::write(&path, vec![0u8; 1536]).unwrap();
            let sidecar = CacheSidecar {
                source_mtime: 1,
                source_size: 1,
                strategy: "remux".into(),
                created_at,
            };
            fs::write(
                sidecar_path(&cache_dir, id),
                serde_json::to_string(&sidecar).unwrap(),
            )
            .unwrap();
        }

        run_cache_cleanup(&cache_dir, &policy);
        assert!(!cache_file_path(&cache_dir, "old").exists());
        assert!(cache_file_path(&cache_dir, "new").exists());
    }

    #[test]
    fn cleanup_skips_partial_files() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        let partial = cache_temp_path(&cache_file_path(&cache_dir, "rec-1"));
        fs::write(&partial, vec![0u8; 10_000]).unwrap();

        let policy = CleanupPolicy {
            ttl: CACHE_TTL,
            max_bytes: 1024,
        };
        run_cache_cleanup(&cache_dir, &policy);
        assert!(partial.exists());
    }

    #[test]
    fn used_bytes_sums_mp4_files() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        fs::write(cache_file_path(&cache_dir, "a"), vec![0u8; 2048]).unwrap();
        fs::write(
            cache_temp_path(&cache_file_path(&cache_dir, "b")),
            vec![0u8; 1024],
        )
        .unwrap();
        fs::write(sidecar_path(&cache_dir, "a"), b"{}").unwrap();

        assert_eq!(playback_cache_used_bytes(&cache_dir), 3072);
    }

    #[test]
    fn clear_playback_cache_dir_removes_cache_files() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("playback");
        fs::create_dir_all(&cache_dir).unwrap();

        fs::write(cache_file_path(&cache_dir, "a"), vec![0u8; 1000]).unwrap();
        fs::write(sidecar_path(&cache_dir, "a"), b"{}").unwrap();

        let freed = clear_playback_cache_dir(&cache_dir).unwrap();
        assert_eq!(freed, 1002);
        assert!(!cache_file_path(&cache_dir, "a").exists());
        assert!(!sidecar_path(&cache_dir, "a").exists());
    }
}
