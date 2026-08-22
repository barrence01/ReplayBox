use crate::job_queue::{new_edit_job_queue, SharedEditJobQueue};
use crate::preview_queue::{new_preview_queue, SharedPreviewQueue};
use crate::settings::{AppPaths, Settings};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashSet;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Default)]
pub struct ScanState {
    pub full: bool,
    pub folders: HashSet<String>,
}

pub struct AppState {
    pub paths: AppPaths,
    pub resource_dir: Option<PathBuf>,
    /// Base URL of the localhost media server (e.g. http://127.0.0.1:12345).
    pub media_base_url: Mutex<Option<String>>,
    pub db: Mutex<Connection>,
    pub settings: Mutex<Settings>,
    pub scan_state: Mutex<ScanState>,
    pub edit_jobs: SharedEditJobQueue,
    /// Running ffmpeg PIDs keyed by edit job id (for cancel).
    pub job_pids: Mutex<HashMap<String, Arc<std::sync::Mutex<Option<u32>>>>>,
    pub preview_queue: SharedPreviewQueue,
}

impl AppState {
    pub fn new(
        paths: AppPaths,
        resource_dir: Option<PathBuf>,
        db: Connection,
        settings: Settings,
    ) -> Arc<Self> {
        Arc::new(Self {
            paths,
            resource_dir,
            media_base_url: Mutex::new(None),
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            scan_state: Mutex::new(ScanState::default()),
            edit_jobs: new_edit_job_queue(),
            job_pids: Mutex::new(HashMap::new()),
            preview_queue: new_preview_queue(),
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
}
