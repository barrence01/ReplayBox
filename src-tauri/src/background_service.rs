use crate::background_events::TauriEventSink;
use crate::game_monitor;
use crate::state::AppState;
use crate::watcher;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::AppHandle;

const UNIT_NAME: &str = "replayboxd.service";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundServiceStatus {
    pub enabled_in_settings: bool,
    pub unit_active: bool,
    pub message: String,
}

/// Resolve the `replayboxd` binary next to the current executable or under target/.
pub fn resolve_daemon_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let beside = exe
        .parent()
        .map(|p| p.join("replayboxd"))
        .filter(|p| p.is_file());
    if let Some(p) = beside {
        return p.canonicalize().map_err(|e| e.to_string());
    }

    let candidates = [
        PathBuf::from("src-tauri/target/debug/replayboxd"),
        PathBuf::from("src-tauri/target/release/replayboxd"),
        PathBuf::from("target/debug/replayboxd"),
        PathBuf::from("target/release/replayboxd"),
    ];
    for c in candidates {
        if c.is_file() {
            return c.canonicalize().map_err(|e| e.to_string());
        }
    }

    Err(
        "replayboxd binary not found. Build it with `cargo build --bin replayboxd` in src-tauri."
            .into(),
    )
}

fn unit_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    let dir = PathBuf::from(home).join(".config/systemd/user");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(UNIT_NAME))
}

fn write_unit(daemon: &Path) -> Result<(), String> {
    let path = unit_path()?;
    let exec = daemon.to_string_lossy();
    let body = format!(
        "[Unit]\n\
         Description=ReplayBox background indexer and session monitor\n\
         After=default.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exec}\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n"
    );
    fs::write(&path, body).map_err(|e| e.to_string())
}

fn systemctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|e| format!("systemctl failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let msg = if stderr.is_empty() { stdout } else { stderr };
        return Err(msg);
    }
    Ok(stdout)
}

pub fn enable_service() -> Result<(), String> {
    let daemon = resolve_daemon_binary()?;
    write_unit(&daemon)?;
    let _ = systemctl(&["daemon-reload"]);
    systemctl(&["enable", "--now", UNIT_NAME])?;
    Ok(())
}

pub fn disable_service() -> Result<(), String> {
    let _ = systemctl(&["disable", "--now", UNIT_NAME]);
    Ok(())
}

pub fn is_unit_active() -> bool {
    systemctl(&["is-active", UNIT_NAME])
        .map(|s| s == "active")
        .unwrap_or(false)
}

pub fn status(enabled_in_settings: bool) -> BackgroundServiceStatus {
    let unit_active = is_unit_active();
    let message = match (enabled_in_settings, unit_active) {
        (true, true) => "Active".to_string(),
        (true, false) => "Enabled in settings but unit is not active".to_string(),
        (false, true) => "Unit still running (disable failed or stale)".to_string(),
        (false, false) => "Inactive".to_string(),
    };
    BackgroundServiceStatus {
        enabled_in_settings,
        unit_active,
        message,
    }
}

/// Apply settings: systemd unit vs in-app background loops.
pub fn sync_runtime(
    app: &AppHandle,
    state: &Arc<AppState>,
    enabled: bool,
) -> Result<(), String> {
    if enabled {
        stop_in_app(state);
        enable_service()?;
    } else {
        disable_service()?;
        let in_app_running = state.watcher.lock().is_some();
        if !in_app_running {
            start_in_app(app, state)?;
        }
    }
    Ok(())
}

pub fn stop_in_app(state: &AppState) {
    state.bg_stop.lock().store(true, Ordering::SeqCst);
    watcher::stop_watcher(state);
}

pub fn start_in_app(app: &AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    stop_in_app(state);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    *state.bg_stop.lock() = stop.clone();
    let sink = TauriEventSink::new(app.clone());
    watcher::start_watcher(state.clone(), sink.clone(), stop.clone())?;
    game_monitor::start_monitor(state.clone(), sink, stop);
    Ok(())
}
