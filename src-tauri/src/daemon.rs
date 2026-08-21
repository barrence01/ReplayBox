use crate::background_events::{self, FileEventSink};
use crate::db;
use crate::game_monitor;
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::tools;
use crate::watcher;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

/// Entry point for the `replayboxd` background daemon.
pub fn run() {
    let app_data = settings::resolve_app_data_dir();
    if let Err(e) = fs::create_dir_all(&app_data) {
        eprintln!("replayboxd: failed to create app data dir: {e}");
        std::process::exit(1);
    }
    let _ = fs::create_dir_all(settings::thumbs_dir(&app_data));

    if let Err(e) = acquire_pid_lock(&app_data) {
        eprintln!("replayboxd: {e}");
        std::process::exit(1);
    }

    let settings = Settings::load(&settings::settings_path(&app_data));
    if !settings.background_service_enabled {
        eprintln!("replayboxd: background service is disabled in settings; exiting");
        release_pid_lock(&app_data);
        std::process::exit(0);
    }

    let resource_dir = tools::discover_resource_dir(None);
    let conn = match db::open_db(&settings::db_path(&app_data)) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("replayboxd: database error: {e}");
            release_pid_lock(&app_data);
            std::process::exit(1);
        }
    };

    let state = AppState::new(app_data.clone(), resource_dir, conn, settings);
    let sink = FileEventSink::new(&app_data);
    let stop = state.bg_stop.lock().clone();

    if let Err(e) = watcher::start_watcher(state.clone(), sink.clone(), stop.clone()) {
        eprintln!("replayboxd: watcher failed: {e}");
    }
    game_monitor::start_monitor(state.clone(), sink, stop.clone());

    let settings_path = settings::settings_path(&app_data);
    let mut last_watch = state.settings.lock().watch_dir.clone();

    while !stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_secs(2));
        let loaded = Settings::load(&settings_path);
        if !loaded.background_service_enabled {
            eprintln!("replayboxd: disabled in settings; shutting down");
            break;
        }
        let watch_changed = loaded.watch_dir != last_watch;
        {
            *state.settings.lock() = loaded;
        }
        if watch_changed {
            last_watch = state.settings.lock().watch_dir.clone();
            let _ = watcher::rewatch(&state);
        }
    }

    watcher::stop_watcher(&state);
    stop.store(true, Ordering::SeqCst);
    release_pid_lock(&app_data);
}

fn acquire_pid_lock(app_data: &std::path::Path) -> Result<(), String> {
    let path = background_events::pid_path(app_data);
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(pid) = raw.trim().parse::<i32>() {
                let proc_path = PathBuf::from(format!("/proc/{pid}"));
                if proc_path.exists() {
                    return Err(format!("already running (pid {pid})"));
                }
            }
        }
    }
    fs::write(&path, std::process::id().to_string()).map_err(|e| e.to_string())
}

fn release_pid_lock(app_data: &std::path::Path) {
    let path = background_events::pid_path(app_data);
    let _ = fs::remove_file(path);
}
