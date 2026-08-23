//! Tray icon idle/busy based on active edit and preview jobs.

use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    image::Image,
    tray::TrayIcon,
    AppHandle, Manager,
};

const IDLE_ICON: &[u8] = include_bytes!("../icons/32x32.png");
const BUSY_ICON: &[u8] = include_bytes!("../icons/32x32-busy.png");

pub struct TrayIconState {
    pub icon: TrayIcon,
    last_busy: AtomicBool,
}

impl TrayIconState {
    pub fn new(icon: TrayIcon) -> Self {
        Self {
            icon,
            last_busy: AtomicBool::new(false),
        }
    }
}

pub fn job_is_active(status: &str) -> bool {
    matches!(status, "queued" | "processing")
}

pub fn queues_are_busy(state: &AppState) -> bool {
    state
        .edit_jobs
        .list()
        .iter()
        .any(|j| job_is_active(&j.status))
        || state
            .preview_queue
            .list()
            .iter()
            .any(|j| job_is_active(&j.status))
}

/// Update tray icon when queue busy state changes. No-op if tray is unavailable.
pub fn refresh_tray_icon(app: &AppHandle) {
    let Some(tray_state) = app.try_state::<Mutex<TrayIconState>>() else {
        return;
    };
    let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() else {
        return;
    };
    let busy = queues_are_busy(app_state.inner());
    let Ok(guard) = tray_state.lock() else {
        return;
    };
    if guard.last_busy.load(Ordering::Acquire) == busy {
        return;
    }
    let bytes = if busy { BUSY_ICON } else { IDLE_ICON };
    match Image::from_bytes(bytes) {
        Ok(image) => {
            if guard.icon.set_icon(Some(image)).is_ok() {
                guard.last_busy.store(busy, Ordering::Release);
            }
        }
        Err(e) => tracing::warn!("tray icon decode failed: {e}"),
    }
}

/// Call after edit/preview queue mutations (not high-frequency progress ticks).
pub fn notify_queues_changed(app: &AppHandle) {
    refresh_tray_icon(app);
}

#[cfg(test)]
mod tests {
    use super::job_is_active;

    #[test]
    fn active_statuses() {
        assert!(job_is_active("queued"));
        assert!(job_is_active("processing"));
        assert!(!job_is_active("completed"));
        assert!(!job_is_active("failed"));
        assert!(!job_is_active("cancelled"));
    }
}
