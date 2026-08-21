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

pub fn installed_daemon_path(app_data: &Path) -> PathBuf {
    app_data.join("bin").join("replayboxd")
}

/// Locate a built or bundled `replayboxd` to copy into app data.
pub fn find_source_daemon() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if let Some(dir) = exe.parent() {
        let beside = dir.join("replayboxd");
        if beside.is_file() {
            return beside.canonicalize().map_err(|e| e.to_string());
        }
    }

    let candidates = [
        PathBuf::from("src-tauri/target/debug/replayboxd"),
        PathBuf::from("src-tauri/target/release/replayboxd"),
        PathBuf::from("target/debug/replayboxd"),
        PathBuf::from("target/release/replayboxd"),
        PathBuf::from("src-tauri/binaries"),
    ];
    for c in &candidates {
        if c.is_file() {
            return c.canonicalize().map_err(|e| e.to_string());
        }
        if c.is_dir() {
            if let Ok(entries) = fs::read_dir(c) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("replayboxd-") && entry.path().is_file() {
                        return entry.path().canonicalize().map_err(|e| e.to_string());
                    }
                }
            }
        }
    }

    Err(
        "replayboxd binary not found. Run `npm run stage:daemon` (or `npm run tauri:dev`) from the repo root."
            .into(),
    )
}

/// Copy the source daemon into `{app_data}/bin/replayboxd` for a stable systemd ExecStart.
pub fn install_daemon(app_data: &Path) -> Result<PathBuf, String> {
    let source = find_source_daemon()?;
    let dest = installed_daemon_path(app_data);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(&source, &dest).map_err(|e| format!("failed to install replayboxd: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dest, perms).map_err(|e| e.to_string())?;
    }
    dest.canonicalize().map_err(|e| e.to_string())
}

fn file_identity(path: &Path) -> Option<(u64, u64)> {
    let meta = fs::metadata(path).ok()?;
    let len = meta.len();
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((len, modified))
}

/// Re-copy daemon when the source binary is newer; restart the unit if it was active.
pub fn refresh_installed_daemon(app_data: &Path) -> Result<(), String> {
    let source = find_source_daemon()?;
    let dest = installed_daemon_path(app_data);
    let needs_copy = match (file_identity(&source), file_identity(&dest)) {
        (Some(s), Some(d)) => s != d,
        (Some(_), None) => true,
        _ => true,
    };
    if !needs_copy {
        return Ok(());
    }
    let was_active = is_unit_active();
    let installed = install_daemon(app_data)?;
    write_unit(&installed)?;
    let _ = systemctl(&["daemon-reload"]);
    if was_active {
        let _ = systemctl(&["restart", UNIT_NAME]);
    }
    Ok(())
}

fn unit_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    let dir = PathBuf::from(home).join(".config/systemd/user");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(UNIT_NAME))
}

fn write_unit(daemon: &Path) -> Result<(), String> {
    let path = unit_path()?;
    let exec = daemon
        .canonicalize()
        .unwrap_or_else(|_| daemon.to_path_buf());
    let exec = exec.to_string_lossy();
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

pub fn enable_service(app_data: &Path) -> Result<(), String> {
    let installed = install_daemon(app_data)?;
    write_unit(&installed)?;
    let _ = systemctl(&["daemon-reload"]);
    systemctl(&["enable", "--now", UNIT_NAME]).map_err(|e| {
        if e.contains("No such file") || e.is_empty() {
            format!(
                "{e} (installed daemon at {}; ensure systemd --user is available)",
                installed.display()
            )
        } else {
            e
        }
    })?;
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
        enable_service(&state.app_data)?;
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
