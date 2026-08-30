use crate::ffmpeg::{self, HardwareEncodingStatus, VideoEncoder};
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
    prefer_hardware_encoding: bool,
    status: Option<HardwareEncodingStatus>,
}

impl EncoderCache {
    pub fn probe_hardware_encoding(
        &mut self,
        ffmpeg_path: &str,
        prefer_hardware_encoding: bool,
    ) -> HardwareEncodingStatus {
        if self.status.is_some()
            && self.ffmpeg_path == ffmpeg_path
            && self.prefer_hardware_encoding == prefer_hardware_encoding
        {
            return self.status.clone().unwrap();
        }
        let status = ffmpeg::hardware_encoding_status(ffmpeg_path, prefer_hardware_encoding);
        self.ffmpeg_path = ffmpeg_path.to_string();
        self.prefer_hardware_encoding = prefer_hardware_encoding;
        self.status = Some(status.clone());
        status
    }

    pub fn invalidate(&mut self) {
        self.ffmpeg_path.clear();
        self.status = None;
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

    pub fn resolved_settings(&self) -> Settings {
        let mut settings = self.settings.lock().clone();
        settings.ffmpeg_path = self.ffmpeg_bin();
        settings.ffprobe_path = self.ffprobe_bin();
        settings
    }

    pub fn hardware_encoding_status(&self) -> HardwareEncodingStatus {
        let settings = self.settings.lock();
        let ffmpeg = crate::tools::resolve_ffmpeg(&settings, self.resource_dir.as_deref());
        let prefer = settings.prefer_hardware_encoding;
        drop(settings);
        self.encoder_cache
            .lock()
            .probe_hardware_encoding(&ffmpeg, prefer)
    }

    pub fn resolved_video_encoder(&self) -> VideoEncoder {
        self.hardware_encoding_status().active
    }

    pub fn preview_video_encoder(&self) -> VideoEncoder {
        let ffmpeg = self.ffmpeg_bin();
        ffmpeg::resolve_video_encoder(&ffmpeg, true)
    }

    pub fn nvenc_available(&self) -> bool {
        matches!(
            self.resolved_video_encoder(),
            VideoEncoder::Nvenc
        )
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
    use super::AppState;
    use super::EncoderCache;
    use crate::ffmpeg::{HardwareEncodingStatus, VideoEncoder};

    fn sample_status(active: VideoEncoder) -> HardwareEncodingStatus {
        HardwareEncodingStatus {
            active,
            nvenc_compiled: true,
            nvenc_runtime: active == VideoEncoder::Nvenc,
            vaapi_compiled: true,
            vaapi_runtime: active == VideoEncoder::Vaapi,
            vaapi_device: None,
        }
    }

    #[test]
    fn encoder_cache_reuses_result_for_same_path_and_preference() {
        let mut cache = EncoderCache {
            ffmpeg_path: "/opt/ffmpeg".into(),
            prefer_hardware_encoding: true,
            status: Some(sample_status(VideoEncoder::Nvenc)),
        };
        let status = cache.probe_hardware_encoding("/opt/ffmpeg", true);
        assert_eq!(status.active, VideoEncoder::Nvenc);
        assert!(cache.status.is_some());
    }

    #[test]
    fn encoder_cache_reprobes_when_ffmpeg_path_changes() {
        let mut cache = EncoderCache {
            ffmpeg_path: "/opt/ffmpeg".into(),
            prefer_hardware_encoding: true,
            status: Some(sample_status(VideoEncoder::Nvenc)),
        };
        let status = cache.probe_hardware_encoding("/missing/ffmpeg-bin", true);
        assert_eq!(cache.ffmpeg_path, "/missing/ffmpeg-bin");
        assert_ne!(status.active, VideoEncoder::Nvenc);
    }

    #[test]
    fn encoder_cache_invalidate_clears_probe() {
        let mut cache = EncoderCache {
            ffmpeg_path: "/opt/ffmpeg".into(),
            prefer_hardware_encoding: true,
            status: Some(sample_status(VideoEncoder::Nvenc)),
        };
        cache.invalidate();
        assert!(cache.ffmpeg_path.is_empty());
        assert!(cache.status.is_none());
    }

    #[test]
    fn resolved_settings_populates_tool_paths_when_saved_settings_are_empty() {
        use crate::db;
        use crate::settings::{AppPaths, Settings};
        use std::fs;
        use std::os::unix::fs::OpenOptionsExt;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let ffmpeg_dir = root.join("ffmpeg");
        fs::create_dir_all(&ffmpeg_dir).unwrap();
        for name in ["ffmpeg", "ffprobe"] {
            fs::OpenOptions::new()
                .write(true)
                .create(true)
                .mode(0o755)
                .open(ffmpeg_dir.join(name))
                .unwrap();
        }
        let paths = AppPaths {
            config_dir: root.to_path_buf(),
            data_dir: root.to_path_buf(),
            log_dir: root.join("logs"),
            cache_dir: root.join("cache"),
        };
        fs::create_dir_all(&paths.log_dir).unwrap();
        let conn = db::open_db(&paths.db_path()).unwrap();
        let state = AppState::new(paths, Some(root.to_path_buf()), conn, Settings::default());
        let settings = state.resolved_settings();
        assert_eq!(
            settings.ffmpeg_path,
            ffmpeg_dir.join("ffmpeg").to_string_lossy()
        );
        assert_eq!(
            settings.ffprobe_path,
            ffmpeg_dir.join("ffprobe").to_string_lossy()
        );
    }

    #[test]
    fn log_dir_is_exposed_on_app_paths() {
        use crate::db;
        use crate::settings::{AppPaths, Settings};
        use std::fs;
        use tempfile::TempDir;

        let dir = TempDir::new().unwrap();
        let root = dir.path();
        let log_dir = root.join("logs");
        let paths = AppPaths {
            config_dir: root.to_path_buf(),
            data_dir: root.to_path_buf(),
            log_dir: log_dir.clone(),
            cache_dir: root.join("cache"),
        };
        fs::create_dir_all(&log_dir).unwrap();
        let conn = db::open_db(&paths.db_path()).unwrap();
        let state = AppState::new(paths, None, conn, Settings::default());
        assert_eq!(state.paths.log_dir, log_dir);
    }
}
