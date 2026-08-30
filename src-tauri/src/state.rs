use crate::ffmpeg;
use crate::job_queue::{new_edit_job_queue, SharedEditJobQueue};
use crate::job_run_gate::JobRunGate;
use crate::preview_queue::{new_preview_queue, SharedPreviewQueue};
use crate::settings::{AppPaths, Settings};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Default)]
pub struct ScanState {
    pub full: bool,
    pub delta: bool,
    pub folders: HashSet<String>,
}

#[derive(Debug, Default)]
pub struct EncoderCache {
    ffmpeg_path: String,
    nvenc_available: Option<bool>,
}

impl EncoderCache {
    pub fn probe_nvenc(&mut self, ffmpeg_path: &str) -> bool {
        if self.nvenc_available.is_some() && self.ffmpeg_path == ffmpeg_path {
            return self.nvenc_available.unwrap_or(false);
        }
        let available = ffmpeg::encoder_available(ffmpeg_path, "h264_nvenc");
        self.ffmpeg_path = ffmpeg_path.to_string();
        self.nvenc_available = Some(available);
        available
    }

    pub fn invalidate(&mut self) {
        self.ffmpeg_path.clear();
        self.nvenc_available = None;
    }
}

pub struct AppState {
    pub paths: AppPaths,
    pub resource_dir: Option<PathBuf>,
    pub media_base_url: Mutex<Option<String>>,
    pub db: Mutex<Connection>,
    pub settings: Mutex<Settings>,
    pub scan_state: Mutex<ScanState>,
    pub job_run_gate: Arc<JobRunGate>,
    pub edit_jobs: SharedEditJobQueue,
    pub job_pids: Mutex<HashMap<String, Arc<Mutex<Option<u32>>>>>,
    pub preview_queue: SharedPreviewQueue,
    pub encoder_cache: Mutex<EncoderCache>,
}

impl AppState {
    pub fn new(
        paths: AppPaths,
        resource_dir: Option<PathBuf>,
        db: Connection,
        settings: Settings,
    ) -> Arc<Self> {
        let job_run_gate = Arc::new(JobRunGate::new());
        Arc::new(Self {
            paths,
            resource_dir,
            media_base_url: Mutex::new(None),
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            scan_state: Mutex::new(ScanState::default()),
            edit_jobs: new_edit_job_queue(job_run_gate.clone()),
            job_pids: Mutex::new(HashMap::new()),
            preview_queue: new_preview_queue(job_run_gate.clone()),
            encoder_cache: Mutex::new(EncoderCache::default()),
            job_run_gate,
        })
    }

    pub fn ffmpeg_bin(&self) -> String {
        let settings = self.settings.lock();
        crate::tools::resolve_ffmpeg(&settings, self.resource_dir.as_deref())
    }

    pub fn ffprobe_bin(&self) -> String {
        let settings = self.settings.lock();
        crate::tools::resolve_ffprobe(&settings, self.resource_dir.as_deref())
    }

    pub fn nvenc_available(&self) -> bool {
        let ffmpeg = self.ffmpeg_bin();
        self.encoder_cache.lock().probe_nvenc(&ffmpeg)
    }

    pub fn notify_job_workers(&self) {
        self.edit_jobs.notify_workers();
        self.preview_queue.notify_workers();
    }

    pub fn set_tray_suspended(&self, suspended: bool) {
        self.job_run_gate.set_tray_suspended(suspended);
        self.notify_job_workers();
    }

    pub fn set_jobs_paused(&self, paused: bool) {
        self.job_run_gate.set_jobs_paused(paused);
        self.notify_job_workers();
    }
}

#[cfg(test)]
mod tests {
    use super::EncoderCache;

    #[test]
    fn encoder_cache_reuses_result_for_same_path() {
        let mut cache = EncoderCache {
            ffmpeg_path: "/opt/ffmpeg".into(),
            nvenc_available: Some(true),
        };
        assert!(cache.probe_nvenc("/opt/ffmpeg"));
        assert_eq!(cache.nvenc_available, Some(true));
    }

    #[test]
    fn encoder_cache_reprobes_when_ffmpeg_path_changes() {
        let mut cache = EncoderCache {
            ffmpeg_path: "/opt/ffmpeg".into(),
            nvenc_available: Some(true),
        };
        let available = cache.probe_nvenc("/missing/ffmpeg-bin");
        assert!(!available);
        assert_eq!(cache.ffmpeg_path, "/missing/ffmpeg-bin");
        assert_eq!(cache.nvenc_available, Some(false));
    }

    #[test]
    fn encoder_cache_invalidate_clears_probe() {
        let mut cache = EncoderCache {
            ffmpeg_path: "/opt/ffmpeg".into(),
            nvenc_available: Some(true),
        };
        cache.invalidate();
        assert!(cache.ffmpeg_path.is_empty());
        assert!(cache.nvenc_available.is_none());
    }
}
