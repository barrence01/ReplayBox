//! FIFO queue for playback preview cache jobs (one processing at a time).

use crate::job_queue::{is_terminal, now_rfc3339};
use crate::models::{JobStatus, Recording};
use crate::playback::PlaybackStrategy;
use crate::playback_cache::{
    cache_file_path, cache_temp_path, is_cache_valid, run_ffmpeg_cache_job, source_metadata,
    write_cache_sidecar, CleanupPolicy,
};
use crate::state::AppState;
use crate::job_run_gate::JobRunGate;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const JOB_STALE_TIMEOUT: Duration = Duration::from_secs(180);
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub enum CacheJobStatus {
    Preparing,
    Ready { path: PathBuf },
    Failed { message: String },
}

struct PreviewEntry {
    job: JobStatus,
    strategy: PlaybackStrategy,
    recording_id: String,
    recording_path: String,
    audio_codec: Option<String>,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
    failed_at: Option<Instant>,
    processing_started: Option<Instant>,
}

struct PreviewQueueInner {
    entries: HashMap<String, PreviewEntry>,
    pending: VecDeque<String>,
    by_recording: HashMap<String, String>,
    processing: Option<String>,
    worker_started: bool,
}

/// Shared preview preparation queue.
pub struct PreviewQueue {
    inner: Mutex<PreviewQueueInner>,
    cvar: Condvar,
    gate: Arc<JobRunGate>,
}

pub type SharedPreviewQueue = Arc<PreviewQueue>;

pub fn new_preview_queue(gate: Arc<JobRunGate>) -> SharedPreviewQueue {
    Arc::new(PreviewQueue::new(gate))
}

impl PreviewQueue {
    pub fn new(gate: Arc<JobRunGate>) -> Self {
        Self {
            inner: Mutex::new(PreviewQueueInner {
                entries: HashMap::new(),
                pending: VecDeque::new(),
                by_recording: HashMap::new(),
                processing: None,
                worker_started: false,
            }),
            cvar: Condvar::new(),
            gate,
        }
    }

    pub fn notify_workers(&self) {
        self.cvar.notify_all();
    }

    pub fn list(&self) -> Vec<JobStatus> {
        let guard = self.inner.lock().expect("preview queue lock");
        let mut jobs: Vec<_> = guard.entries.values().map(|e| e.job.clone()).collect();
        jobs.sort_by(|a, b| a.queued_at.cmp(&b.queued_at));
        jobs
    }

    pub fn get(&self, job_id: &str) -> Option<JobStatus> {
        self.inner
            .lock()
            .expect("preview queue lock")
            .entries
            .get(job_id)
            .map(|e| e.job.clone())
    }

    /// Active preview job for a recording, plus 1-based position among queued jobs.
    pub fn lookup_by_recording(&self, recording_id: &str) -> Option<(JobStatus, Option<u32>)> {
        let guard = self.inner.lock().expect("preview queue lock");
        let job_id = guard.by_recording.get(recording_id)?;
        let entry = guard.entries.get(job_id)?;
        if entry.job.status != "queued" && entry.job.status != "processing" {
            return None;
        }
        let position = if entry.job.status == "queued" {
            guard
                .pending
                .iter()
                .position(|id| id == job_id)
                .map(|i| (i + 1) as u32)
        } else {
            None
        };
        Some((entry.job.clone(), position))
    }

    pub fn dismiss(&self, job_id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock().expect("preview queue lock");
        let entry = guard
            .entries
            .get(job_id)
            .ok_or_else(|| "Preview job not found".to_string())?;
        if !is_terminal(&entry.job.status) {
            return Err("Only finished preview jobs can be dismissed".into());
        }
        let recording_id = entry.recording_id.clone();
        guard.entries.remove(job_id);
        if guard.by_recording.get(&recording_id).map(|s| s.as_str()) == Some(job_id) {
            guard.by_recording.remove(&recording_id);
        }
        Ok(())
    }

    pub fn clear_finished(&self) {
        let mut guard = self.inner.lock().expect("preview queue lock");
        let finished: Vec<(String, String)> = guard
            .entries
            .iter()
            .filter(|(_, e)| is_terminal(&e.job.status))
            .map(|(id, e)| (id.clone(), e.recording_id.clone()))
            .collect();
        for (id, recording_id) in finished {
            guard.entries.remove(&id);
            if guard.by_recording.get(&recording_id).map(|s| s.as_str()) == Some(id.as_str()) {
                guard.by_recording.remove(&recording_id);
            }
        }
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<JobStatus, String> {
        let mut guard = self.inner.lock().expect("preview queue lock");
        let status = guard
            .entries
            .get(job_id)
            .ok_or_else(|| "Preview job not found".to_string())?
            .job
            .status
            .clone();

        match status.as_str() {
            "queued" => {
                guard.pending.retain(|id| id != job_id);
                let entry = guard
                    .entries
                    .get_mut(job_id)
                    .ok_or_else(|| "Preview job not found".to_string())?;
                entry.job.status = "cancelled".into();
                entry.job.message = Some("Cancelled by user".into());
                entry.job.finished_at = Some(now_rfc3339());
                entry.cancel.store(true, Ordering::Relaxed);
                Ok(entry.job.clone())
            }
            "processing" => {
                let entry = guard
                    .entries
                    .get_mut(job_id)
                    .ok_or_else(|| "Preview job not found".to_string())?;
                entry.cancel.store(true, Ordering::Relaxed);
                kill_child(&entry.child);
                entry.job.status = "cancelled".into();
                entry.job.message = Some("Cancelled by user".into());
                if entry.job.finished_at.is_none() {
                    entry.job.finished_at = Some(now_rfc3339());
                }
                Ok(entry.job.clone())
            }
            _ => Err("Preview job is not cancellable".into()),
        }
    }

    /// Cancel the active preview job for a recording, if any (queued or processing).
    pub fn cancel_for_recording(
        &self,
        recording_id: &str,
        message: Option<&str>,
    ) -> Option<JobStatus> {
        let job_id = self.lookup_by_recording(recording_id)?.0.id;
        match self.cancel_job(&job_id) {
            Ok(mut job) => {
                if let Some(msg) = message {
                    if let Ok(mut guard) = self.inner.lock() {
                        if let Some(entry) = guard.entries.get_mut(&job.id) {
                            entry.job.message = Some(msg.into());
                            job = entry.job.clone();
                        }
                    }
                }
                Some(job)
            }
            Err(_) => None,
        }
    }

    /// Cancel all queued and processing preview jobs. Returns cancelled snapshots.
    pub fn cancel_all(&self) -> Vec<JobStatus> {
        let mut guard = self.inner.lock().expect("preview queue lock");
        let mut cancelled = Vec::new();
        let pending: Vec<String> = guard.pending.drain(..).collect();
        for id in pending {
            if let Some(entry) = guard.entries.get_mut(&id) {
                entry.cancel.store(true, Ordering::Relaxed);
                entry.job.status = "cancelled".into();
                entry.job.message = Some("Cancelled".into());
                entry.job.finished_at = Some(now_rfc3339());
                cancelled.push(entry.job.clone());
            }
        }
        if let Some(id) = guard.processing.clone() {
            if let Some(entry) = guard.entries.get_mut(&id) {
                entry.cancel.store(true, Ordering::Relaxed);
                kill_child(&entry.child);
                entry.job.status = "cancelled".into();
                entry.job.message = Some("Cancelled".into());
                if entry.job.finished_at.is_none() {
                    entry.job.finished_at = Some(now_rfc3339());
                }
                cancelled.push(entry.job.clone());
            }
        }
        self.cvar.notify_all();
        cancelled
    }

    pub fn ensure_worker_started<F>(&self, start: F)
    where
        F: FnOnce(),
    {
        let mut guard = self.inner.lock().expect("preview queue lock");
        if !guard.worker_started {
            guard.worker_started = true;
            drop(guard);
            start();
        }
    }

    pub fn take_next_work(&self) -> (String, PreviewWork) {
        let mut guard = self.inner.lock().expect("preview queue lock");
        loop {
            if let Some(work) = self.activate_next_locked(&mut guard) {
                return work;
            }
            guard = self.cvar.wait(guard).expect("preview queue wait");
        }
    }

    #[cfg(test)]
    pub fn try_take_next(&self) -> Option<(String, PreviewWork)> {
        let mut guard = self.inner.lock().expect("preview queue lock");
        self.activate_next_locked(&mut guard)
    }

    fn activate_next_locked(&self, guard: &mut PreviewQueueInner) -> Option<(String, PreviewWork)> {
        if self.gate.is_paused() || guard.processing.is_some() {
            return None;
        }
        while let Some(id) = guard.pending.pop_front() {
            let Some(entry) = guard.entries.get_mut(&id) else {
                continue;
            };
            if entry.job.status == "cancelled" {
                continue;
            }
            entry.job.status = "processing".into();
            entry.job.started_at = Some(now_rfc3339());
            entry.processing_started = Some(Instant::now());
            guard.processing = Some(id.clone());
            return Some((
                id.clone(),
                PreviewWork {
                    recording_id: entry.recording_id.clone(),
                    recording_path: entry.recording_path.clone(),
                    audio_codec: entry.audio_codec.clone(),
                    strategy: entry.strategy,
                    cancel: entry.cancel.clone(),
                    child: entry.child.clone(),
                },
            ));
        }
        None
    }

    pub fn finish_work(
        &self,
        job_id: &str,
        result: Result<PathBuf, String>,
    ) -> Option<JobStatus> {
        let mut guard = self.inner.lock().expect("preview queue lock");
        if guard.processing.as_deref() == Some(job_id) {
            guard.processing = None;
        }
        let entry = guard.entries.get_mut(job_id)?;
        if entry.job.status != "cancelled" {
            match result {
                Ok(path) => {
                    entry.job.status = "completed".into();
                    entry.job.progress = 1.0;
                    entry.job.output_path = Some(path.to_string_lossy().to_string());
                    entry.job.message = Some("Preview ready".into());
                }
                Err(e) => {
                    entry.failed_at = Some(Instant::now());
                    entry.job.status = "failed".into();
                    entry.job.message = Some(e);
                }
            }
        }
        if entry.job.finished_at.is_none() {
            entry.job.finished_at = Some(now_rfc3339());
        }
        let snapshot = entry.job.clone();
        self.cvar.notify_one();
        Some(snapshot)
    }

    pub fn ensure_cache_job(
        &self,
        state: &AppState,
        recording: &Recording,
        strategy: PlaybackStrategy,
        on_enqueue: impl Fn(JobStatus),
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

        let mut guard = self.inner.lock().expect("preview queue lock");

        if let Some(existing_id) = guard.by_recording.get(&recording.id).cloned() {
            let resolved = guard
                .entries
                .get_mut(&existing_id)
                .and_then(|entry| resolve_existing(entry, strategy));
            match resolved {
                Some(status) => return status,
                None => {
                    if let Some(entry) = guard.entries.get_mut(&existing_id) {
                        entry.cancel.store(true, Ordering::Relaxed);
                        kill_child(&entry.child);
                    }
                    guard.pending.retain(|id| id != &existing_id);
                    if guard.processing.as_deref() == Some(existing_id.as_str()) {
                        guard.processing = None;
                    }
                    guard.entries.remove(&existing_id);
                    guard.by_recording.remove(&recording.id);
                }
            }
        }

        let job_id = Uuid::new_v4().to_string();
        let job = JobStatus {
            id: job_id.clone(),
            kind: "preview".into(),
            status: "queued".into(),
            progress: 0.0,
            message: Some("Waiting in queue".into()),
            output_path: None,
            source_path: Some(recording.path.clone()),
            source_filename: Some(recording.filename.clone()),
            queued_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
        };

        let entry = PreviewEntry {
            job: job.clone(),
            strategy,
            recording_id: recording.id.clone(),
            recording_path: recording.path.clone(),
            audio_codec: recording.audio_codec.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            failed_at: None,
            processing_started: None,
        };

        guard.entries.insert(job_id.clone(), entry);
        guard.by_recording.insert(recording.id.clone(), job_id.clone());
        guard.pending.push_back(job_id);
        self.cvar.notify_one();
        drop(guard);

        on_enqueue(job);
        CacheJobStatus::Preparing
    }
}

pub struct PreviewWork {
    pub recording_id: String,
    pub recording_path: String,
    pub audio_codec: Option<String>,
    pub strategy: PlaybackStrategy,
    pub cancel: Arc<AtomicBool>,
    pub child: Arc<Mutex<Option<Child>>>,
}

fn strategy_rank(strategy: PlaybackStrategy) -> u8 {
    match strategy {
        PlaybackStrategy::Direct => 0,
        PlaybackStrategy::RemuxAudio => 1,
        PlaybackStrategy::Transcode => 2,
    }
}

fn resolve_existing(entry: &mut PreviewEntry, strategy: PlaybackStrategy) -> Option<CacheJobStatus> {
    match entry.job.status.as_str() {
        "completed" => {
            if let Some(path) = &entry.job.output_path {
                let p = PathBuf::from(path);
                if p.is_file() && strategy_rank(entry.strategy) >= strategy_rank(strategy) {
                    return Some(CacheJobStatus::Ready { path: p });
                }
            }
            None
        }
        "queued" | "processing" if entry.strategy == strategy => {
            if entry.job.status == "processing" {
                if let Some(started) = entry.processing_started {
                    if started.elapsed() > JOB_STALE_TIMEOUT {
                        entry.job.status = "failed".into();
                        entry.job.message = Some("Preview preparation timed out".into());
                        entry.job.finished_at = Some(now_rfc3339());
                        entry.failed_at = Some(Instant::now());
                        entry.cancel.store(true, Ordering::Relaxed);
                        kill_child(&entry.child);
                        return Some(CacheJobStatus::Failed {
                            message: "Preview preparation timed out".into(),
                        });
                    }
                }
            }
            Some(CacheJobStatus::Preparing)
        }
        "failed" if entry.strategy == strategy => {
            if entry
                .failed_at
                .is_some_and(|t| t.elapsed() >= FAILURE_COOLDOWN)
            {
                None
            } else {
                Some(CacheJobStatus::Failed {
                    message: entry
                        .job
                        .message
                        .clone()
                        .unwrap_or_else(|| "Preview preparation failed".into()),
                })
            }
        }
        "queued" | "processing" | "failed" => {
            if strategy_rank(strategy) > strategy_rank(entry.strategy) {
                None
            } else if entry.job.status == "failed" {
                Some(CacheJobStatus::Failed {
                    message: entry
                        .job
                        .message
                        .clone()
                        .unwrap_or_else(|| "Preview preparation failed".into()),
                })
            } else {
                Some(CacheJobStatus::Preparing)
            }
        }
        "cancelled" => None,
        _ => None,
    }
}

fn kill_child(child_slot: &Arc<Mutex<Option<Child>>>) {
    if let Ok(mut guard) = child_slot.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Runs the preview worker loop until process exit.
pub fn spawn_preview_worker(app: tauri::AppHandle, state: Arc<AppState>) {
    state.preview_queue.ensure_worker_started(|| {
        let app = app.clone();
        let state = state.clone();
        thread::spawn(move || loop {
            let (job_id, work) = state.preview_queue.take_next_work();
            let paths = state.paths.clone();
            let ffmpeg = state.ffmpeg_bin();
            let cleanup_policy = CleanupPolicy::from_settings(&state.settings.lock());
            let cache_dir = paths.playback_cache_dir();
            let output = cache_file_path(&cache_dir, &work.recording_id);
            let input = PathBuf::from(&work.recording_path);

            tracing::info!(
                recording_id = %work.recording_id,
                strategy = ?work.strategy,
                job_id = %job_id,
                "playback cache job started"
            );

            if let Some(job) = state.preview_queue.get(&job_id) {
                let _ = app.emit("preview-updated", job);
                crate::tray_status::notify_queues_changed(&app);
            }

            let started = Instant::now();
            let result = run_ffmpeg_cache_job(
                &ffmpeg,
                &input,
                &output,
                work.strategy,
                work.audio_codec.as_deref(),
                &work.cancel,
                &work.child,
            )
            .and_then(|_| {
                if let Ok((mtime, size)) = source_metadata(&input) {
                    let _ = write_cache_sidecar(
                        &cache_dir,
                        &work.recording_id,
                        mtime,
                        size,
                        work.strategy,
                    );
                }
                crate::playback_cache::run_cache_cleanup(&cache_dir, &cleanup_policy);
                Ok(output.clone())
            });

            let elapsed_ms = started.elapsed().as_millis();
            match &result {
                Ok(_) => tracing::info!(
                    recording_id = %work.recording_id,
                    duration_ms = elapsed_ms,
                    "playback cache job ready"
                ),
                Err(e) => {
                    tracing::error!(
                        recording_id = %work.recording_id,
                        strategy = ?work.strategy,
                        duration_ms = elapsed_ms,
                        error = %e,
                        "playback cache job failed; see ffmpeg.log for stderr"
                    );
                    let _ = fs::remove_file(&output);
                    let _ = fs::remove_file(cache_temp_path(&output));
                }
            }

            if let Some(job) = state.preview_queue.finish_work(&job_id, result) {
                let _ = app.emit("preview-updated", job);
                crate::tray_status::notify_queues_changed(&app);
            }
        });
    });
}

use tauri::Emitter;

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_recording(id: &str) -> Recording {
        Recording {
            id: id.into(),
            path: format!("/tmp/{id}.mp4"),
            filename: format!("{id}.mp4"),
            dir: "/tmp".into(),
            size_bytes: None,
            duration_ms: Some(1000.0),
            width: None,
            height: None,
            video_codec: None,
            audio_codec: Some("aac".into()),
            is_vfr: false,
            created_at: None,
            modified_at: None,
            thumbnail_path: None,
            session_id: None,
            indexed_at: now_rfc3339(),
        }
    }

    fn enqueue_raw(q: &PreviewQueue, id: &str, strategy: PlaybackStrategy) -> String {
        let recording = sample_recording(id);
        let job_id = Uuid::new_v4().to_string();
        let job = JobStatus {
            id: job_id.clone(),
            kind: "preview".into(),
            status: "queued".into(),
            progress: 0.0,
            message: Some("Waiting in queue".into()),
            output_path: None,
            source_path: Some(recording.path.clone()),
            source_filename: Some(recording.filename.clone()),
            queued_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
        };
        let entry = PreviewEntry {
            job,
            strategy,
            recording_id: recording.id.clone(),
            recording_path: recording.path.clone(),
            audio_codec: recording.audio_codec.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            child: Arc::new(Mutex::new(None)),
            failed_at: None,
            processing_started: None,
        };
        let mut guard = q.inner.lock().unwrap();
        guard.entries.insert(job_id.clone(), entry);
        guard.by_recording.insert(recording.id, job_id.clone());
        guard.pending.push_back(job_id.clone());
        job_id
    }

    #[test]
    fn fifo_only_one_processing() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let a = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        let b = enqueue_raw(&q, "b", PlaybackStrategy::Transcode);
        let (id, _) = q.try_take_next().unwrap();
        assert_eq!(id, a);
        assert!(q.try_take_next().is_none());
        q.finish_work(&a, Ok(PathBuf::from("/tmp/a.mp4")));
        let (id2, _) = q.try_take_next().unwrap();
        assert_eq!(id2, b);
    }

    #[test]
    fn cancel_queued() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let id = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        let job = q.cancel_job(&id).unwrap();
        assert_eq!(job.status, "cancelled");
        assert!(q.inner.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn cancel_for_recording_cancels_queued() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let id = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        let job = q
            .cancel_for_recording("a", Some("Cancelled: recording deleted"))
            .unwrap();
        assert_eq!(job.id, id);
        assert_eq!(job.status, "cancelled");
        assert_eq!(
            job.message.as_deref(),
            Some("Cancelled: recording deleted")
        );
        assert!(q.lookup_by_recording("a").is_none());
        assert!(q.inner.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn cancel_for_recording_cancels_processing() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let id = enqueue_raw(&q, "a", PlaybackStrategy::Transcode);
        let (taken, _) = q.try_take_next().unwrap();
        assert_eq!(taken, id);
        let job = q.cancel_for_recording("a", None).unwrap();
        assert_eq!(job.status, "cancelled");
        assert!(q.lookup_by_recording("a").is_none());
    }

    #[test]
    fn cancel_for_recording_noop_when_absent() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        assert!(q.cancel_for_recording("missing", None).is_none());
    }

    #[test]
    fn lookup_by_recording_returns_position() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let a = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        let _b = enqueue_raw(&q, "b", PlaybackStrategy::RemuxAudio);

        let (job_b, pos_b) = q.lookup_by_recording("b").unwrap();
        assert_eq!(job_b.status, "queued");
        assert_eq!(pos_b, Some(2));

        let (id, _) = q.try_take_next().unwrap();
        assert_eq!(id, a);
        let (job_a, pos_a) = q.lookup_by_recording("a").unwrap();
        assert_eq!(job_a.status, "processing");
        assert_eq!(pos_a, None);
    }

    #[test]
    fn lookup_ignores_terminal() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let a = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        q.try_take_next().unwrap();
        q.finish_work(&a, Ok(PathBuf::from("/tmp/a.mp4")));
        assert!(q.lookup_by_recording("a").is_none());
    }

    #[test]
    fn dismiss_terminal_only() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let a = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        assert!(q.dismiss(&a).is_err());

        q.try_take_next().unwrap();
        q.finish_work(&a, Ok(PathBuf::from("/tmp/a.mp4")));
        assert!(q.dismiss(&a).is_ok());
        assert!(q.list().is_empty());
    }

    #[test]
    fn clear_finished_keeps_queued() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let a = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        let _b = enqueue_raw(&q, "b", PlaybackStrategy::RemuxAudio);
        q.try_take_next().unwrap();
        q.finish_work(&a, Ok(PathBuf::from("/tmp/a.mp4")));

        q.clear_finished();
        let listed = q.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, "queued");
        assert_eq!(listed[0].source_filename.as_deref(), Some("b.mp4"));
    }

    #[test]
    fn cancel_processing_sets_finished_at() {
        let q = PreviewQueue::new(Arc::new(JobRunGate::new()));
        let a = enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);
        q.try_take_next().unwrap();
        let job = q.cancel_job(&a).unwrap();
        assert_eq!(job.status, "cancelled");
        assert!(job.finished_at.is_some());
    }

    #[test]
    fn paused_gate_blocks_take_next() {
        let gate = Arc::new(JobRunGate::new());
        let q = PreviewQueue::new(gate.clone());
        enqueue_raw(&q, "a", PlaybackStrategy::RemuxAudio);

        gate.set_jobs_paused(true);
        assert!(q.try_take_next().is_none());

        gate.set_jobs_paused(false);
        assert!(q.try_take_next().is_some());
    }
}
