//! Shared FIFO queue for trim and compress edit jobs (one processing at a time).

use crate::job_run_gate::JobRunGate;
use crate::models::{CompressRequest, JobStatus, Recording, TrimRequest};
use crate::settings::Settings;
use chrono::Utc;
use parking_lot::{Condvar, Mutex};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub enum PendingEditJob {
    Trim {
        settings: Settings,
        recording: Recording,
        request: TrimRequest,
        dest: PathBuf,
    },
    Compress {
        settings: Settings,
        recording: Recording,
        request: CompressRequest,
        dest: PathBuf,
    },
}

struct EditQueueInner {
    jobs: HashMap<String, JobStatus>,
    pending: VecDeque<String>,
    payloads: HashMap<String, PendingEditJob>,
    processing: Option<String>,
    worker_started: bool,
}

/// Thread-safe edit job queue with a single worker.
pub struct EditJobQueue {
    inner: Mutex<EditQueueInner>,
    cvar: Condvar,
    gate: Arc<JobRunGate>,
}

impl EditJobQueue {
    pub fn new(gate: Arc<JobRunGate>) -> Self {
        Self {
            inner: Mutex::new(EditQueueInner {
                jobs: HashMap::new(),
                pending: VecDeque::new(),
                payloads: HashMap::new(),
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

    pub fn enqueue(&self, job: JobStatus, payload: PendingEditJob) -> JobStatus {
        let mut guard = self.inner.lock();
        let id = job.id.clone();
        guard.jobs.insert(id.clone(), job.clone());
        guard.payloads.insert(id.clone(), payload);
        guard.pending.push_back(id);
        self.cvar.notify_one();
        job
    }

    pub fn list(&self) -> Vec<JobStatus> {
        let guard = self.inner.lock();
        let mut jobs: Vec<_> = guard.jobs.values().cloned().collect();
        jobs.sort_by(|a, b| a.queued_at.cmp(&b.queued_at));
        jobs
    }

    pub fn has_active_jobs(&self) -> bool {
        let guard = self.inner.lock();
        guard
            .jobs
            .values()
            .any(|job| matches!(job.status.as_str(), "queued" | "processing"))
    }

    pub fn get(&self, job_id: &str) -> Option<JobStatus> {
        self.inner
            .lock()
            .jobs
            .get(job_id)
            .cloned()
    }

    pub fn update_progress(&self, job_id: &str, fraction: f64) -> Option<JobStatus> {
        let mut guard = self.inner.lock();
        let job = guard.jobs.get_mut(job_id)?;
        if job.status != "processing" {
            return None;
        }
        job.progress = fraction;
        Some(job.clone())
    }

    pub fn mark_cancelled_if_queued(&self, job_id: &str) -> Option<JobStatus> {
        let mut guard = self.inner.lock();
        let status = guard.jobs.get(job_id)?.status.clone();
        if status != "queued" {
            return None;
        }
        guard.pending.retain(|id| id != job_id);
        guard.payloads.remove(job_id);
        let job = guard.jobs.get_mut(job_id)?;
        job.status = "cancelled".into();
        job.message = Some("Cancelled by user".into());
        job.finished_at = Some(Utc::now().to_rfc3339());
        Some(job.clone())
    }

    pub fn mark_cancelled_processing(&self, job_id: &str) -> Option<JobStatus> {
        let mut guard = self.inner.lock();
        let job = guard.jobs.get_mut(job_id)?;
        if job.status != "processing" {
            return None;
        }
        job.status = "cancelled".into();
        job.message = Some("Cancelled by user".into());
        if job.finished_at.is_none() {
            job.finished_at = Some(Utc::now().to_rfc3339());
        }
        Some(job.clone())
    }

    pub fn is_processing(&self, job_id: &str) -> bool {
        let guard = self.inner.lock();
        guard.processing.as_deref() == Some(job_id)
    }

    pub fn dismiss(&self, job_id: &str) -> Result<(), String> {
        let mut guard = self.inner.lock();
        let job = guard
            .jobs
            .get(job_id)
            .ok_or_else(|| "Job not found".to_string())?;
        if !is_terminal(&job.status) {
            return Err("Only finished jobs can be dismissed".into());
        }
        guard.jobs.remove(job_id);
        Ok(())
    }

    pub fn clear_finished(&self) {
        let mut guard = self.inner.lock();
        guard.jobs.retain(|_, job| !is_terminal(&job.status));
    }

    fn activate_next_locked(
        &self,
        guard: &mut EditQueueInner,
    ) -> Option<(String, PendingEditJob)> {
        if self.gate.is_paused() || guard.processing.is_some() {
            return None;
        }
        while let Some(id) = guard.pending.pop_front() {
            let Some(payload) = guard.payloads.remove(&id) else {
                continue;
            };
            if let Some(job) = guard.jobs.get_mut(&id) {
                if job.status == "cancelled" {
                    continue;
                }
                job.status = "processing".into();
                job.started_at = Some(Utc::now().to_rfc3339());
                job.progress = 0.0;
            }
            guard.processing = Some(id.clone());
            return Some((id, payload));
        }
        None
    }

    pub fn take_next_work(&self) -> (String, PendingEditJob) {
        let mut guard = self.inner.lock();
        loop {
            if let Some(work) = self.activate_next_locked(&mut guard) {
                return work;
            }
            self.cvar.wait(&mut guard);
        }
    }

    #[cfg(test)]
    pub fn try_take_next(&self) -> Option<(String, PendingEditJob)> {
        let mut guard = self.inner.lock();
        self.activate_next_locked(&mut guard)
    }

    /// Ids of queued jobs plus the job currently processing, if any.
    pub fn active_job_ids(&self) -> Vec<String> {
        let guard = self.inner.lock();
        let mut ids: Vec<String> = guard.pending.iter().cloned().collect();
        if let Some(id) = guard.processing.clone() {
            ids.push(id);
        }
        ids
    }

    pub fn finish_job(
        &self,
        job_id: &str,
        status: &str,
        message: Option<String>,
        output_path: Option<String>,
        progress: Option<f64>,
    ) -> Option<JobStatus> {
        let mut guard = self.inner.lock();
        if guard.processing.as_deref() == Some(job_id) {
            guard.processing = None;
        }
        let job = guard.jobs.get_mut(job_id)?;
        if job.status != "cancelled" {
            job.status = status.into();
            job.message = message;
            if let Some(path) = output_path {
                job.output_path = Some(path);
            }
            if let Some(p) = progress {
                job.progress = p;
            }
        }
        if job.finished_at.is_none() {
            job.finished_at = Some(Utc::now().to_rfc3339());
        }
        let snapshot = job.clone();
        self.cvar.notify_one();
        Some(snapshot)
    }

    pub fn snapshot_job(&self, job_id: &str) -> Option<JobStatus> {
        self.get(job_id)
    }

    pub fn ensure_worker_started<F>(&self, start: F)
    where
        F: FnOnce(),
    {
        let mut guard = self.inner.lock();
        if !guard.worker_started {
            guard.worker_started = true;
            drop(guard);
            start();
        }
    }
}

pub fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

pub fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

pub type SharedEditJobQueue = Arc<EditJobQueue>;

pub fn new_edit_job_queue(gate: Arc<JobRunGate>) -> SharedEditJobQueue {
    Arc::new(EditJobQueue::new(gate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompressRequest, Recording, TrimRequest};

    fn test_queue() -> EditJobQueue {
        EditJobQueue::new(Arc::new(JobRunGate::new()))
    }

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
            audio_codec: None,
            is_vfr: false,
            created_at: None,
            modified_at: None,
            thumbnail_path: None,
            session_id: None,
            indexed_at: now_rfc3339(),
        }
    }

    fn queued_job(id: &str, kind: &str) -> JobStatus {
        JobStatus {
            id: id.into(),
            kind: kind.into(),
            status: "queued".into(),
            progress: 0.0,
            message: None,
            output_path: Some("/tmp/out.mp4".into()),
            source_path: Some("/tmp/in.mp4".into()),
            source_filename: Some("in.mp4".into()),
            queued_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
        }
    }

    fn trim_payload(id: &str) -> PendingEditJob {
        PendingEditJob::Trim {
            settings: Settings::default(),
            recording: sample_recording(id),
            request: TrimRequest {
                recording_id: id.into(),
                start_ms: 0.0,
                end_ms: 1000.0,
                output_mode: "copy".into(),
                copy_collision: None,
            },
            dest: PathBuf::from("/tmp/out.mp4"),
        }
    }

    fn compress_payload(id: &str) -> PendingEditJob {
        PendingEditJob::Compress {
            settings: Settings::default(),
            recording: sample_recording(id),
            request: CompressRequest {
                recording_id: id.into(),
                crf: Some(26),
                use_nvenc: Some(false),
                output_mode: "copy".into(),
                copy_collision: None,
                fps: Some(60),
            },
            dest: PathBuf::from("/tmp/out.mp4"),
        }
    }

    #[test]
    fn has_active_jobs_tracks_queued_and_clears_when_cancelled() {
        let q = test_queue();
        q.enqueue(queued_job("t1", "trim"), trim_payload("t1"));
        q.enqueue(queued_job("c1", "compress"), compress_payload("c1"));
        assert!(q.has_active_jobs());
        q.mark_cancelled_if_queued("t1").unwrap();
        q.mark_cancelled_if_queued("c1").unwrap();
        assert!(!q.has_active_jobs());
    }

    #[test]
    fn enqueue_mixed_kinds_stay_queued_until_taken() {
        let q = test_queue();
        q.enqueue(queued_job("t1", "trim"), trim_payload("t1"));
        q.enqueue(queued_job("c1", "compress"), compress_payload("c1"));
        q.enqueue(queued_job("t2", "trim"), trim_payload("t2"));

        let listed = q.list();
        assert_eq!(listed.len(), 3);
        assert!(listed.iter().all(|j| j.status == "queued"));

        let front = q.inner.lock().pending.front().cloned();
        assert_eq!(front.as_deref(), Some("t1"));
    }

    #[test]
    fn cancel_queued_removes_from_pending() {
        let q = test_queue();
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));
        q.enqueue(queued_job("b", "compress"), compress_payload("b"));

        let cancelled = q.mark_cancelled_if_queued("b").unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.finished_at.is_some());

        let pending: Vec<_> = q.inner.lock().pending.iter().cloned().collect();
        assert_eq!(pending, vec!["a".to_string()]);
    }

    #[test]
    fn take_next_marks_processing_and_only_one() {
        let q = test_queue();
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));
        q.enqueue(queued_job("b", "compress"), compress_payload("b"));

        let (id, _) = q.try_take_next().unwrap();
        assert_eq!(id, "a");
        assert_eq!(q.get("a").unwrap().status, "processing");
        assert_eq!(q.get("b").unwrap().status, "queued");
        assert!(q.try_take_next().is_none());

        q.finish_job("a", "completed", Some("ok".into()), None, Some(1.0));
        let (id2, _) = q.try_take_next().unwrap();
        assert_eq!(id2, "b");
    }

    #[test]
    fn dismiss_only_terminal() {
        let q = test_queue();
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));
        assert!(q.dismiss("a").is_err());
        q.mark_cancelled_if_queued("a").unwrap();
        assert!(q.dismiss("a").is_ok());
        assert!(q.get("a").is_none());
    }

    #[test]
    fn cancel_processing_sets_finished_at() {
        let q = test_queue();
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));
        let (id, _) = q.try_take_next().unwrap();
        assert_eq!(id, "a");

        let cancelled = q.mark_cancelled_processing("a").unwrap();
        assert_eq!(cancelled.status, "cancelled");
        assert!(cancelled.finished_at.is_some());
    }

    #[test]
    fn clear_finished_keeps_active() {
        let q = test_queue();
        q.enqueue(queued_job("done", "trim"), trim_payload("done"));
        q.enqueue(queued_job("active", "compress"), compress_payload("active"));
        let (id, _) = q.try_take_next().unwrap();
        q.finish_job(&id, "completed", Some("ok".into()), None, Some(1.0));

        q.clear_finished();
        let listed = q.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "active");
        assert_eq!(listed[0].status, "queued");
    }

    #[test]
    fn update_progress_only_while_processing() {
        let q = test_queue();
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));
        assert!(q.update_progress("a", 0.5).is_none());

        let (id, _) = q.try_take_next().unwrap();
        let updated = q.update_progress(&id, 0.42).unwrap();
        assert_eq!(updated.status, "processing");
        assert!((updated.progress - 0.42).abs() < f64::EPSILON);
    }

    #[test]
    fn dismiss_rejects_processing() {
        let q = test_queue();
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));
        let (id, _) = q.try_take_next().unwrap();
        let err = q.dismiss(&id).unwrap_err();
        assert!(err.contains("finished"));
    }

    #[test]
    fn paused_gate_blocks_take_next() {
        let gate = Arc::new(JobRunGate::new());
        let q = EditJobQueue::new(gate.clone());
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));

        gate.set_jobs_paused(true);
        assert!(q.try_take_next().is_none());
        assert_eq!(q.get("a").unwrap().status, "queued");

        gate.set_jobs_paused(false);
        let (id, _) = q.try_take_next().unwrap();
        assert_eq!(id, "a");
    }

    #[test]
    fn tray_suspended_blocks_take_next() {
        let gate = Arc::new(JobRunGate::new());
        let q = EditJobQueue::new(gate.clone());
        q.enqueue(queued_job("a", "trim"), trim_payload("a"));

        gate.set_tray_suspended(true);
        assert!(q.try_take_next().is_none());

        gate.set_tray_suspended(false);
        assert!(q.try_take_next().is_some());
    }
}
