use crate::models::JobStatus;
use crate::settings::Settings;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub app_data: PathBuf,
    pub resource_dir: Option<PathBuf>,
    /// Base URL of the localhost media server (e.g. http://127.0.0.1:12345).
    pub media_base_url: Mutex<Option<String>>,
    pub db: Mutex<Connection>,
    pub settings: Mutex<Settings>,
    pub jobs: Mutex<HashMap<String, JobStatus>>,
    /// Running ffmpeg PIDs keyed by job id (for cancel).
    pub job_pids: Mutex<HashMap<String, Arc<std::sync::Mutex<Option<u32>>>>>,
}

impl AppState {
    pub fn new(
        app_data: PathBuf,
        resource_dir: Option<PathBuf>,
        db: Connection,
        settings: Settings,
    ) -> Arc<Self> {
        Arc::new(Self {
            app_data,
            resource_dir,
            media_base_url: Mutex::new(None),
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            jobs: Mutex::new(HashMap::new()),
            job_pids: Mutex::new(HashMap::new()),
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
