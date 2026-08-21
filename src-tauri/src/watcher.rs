use crate::catalog::{self, is_video_file, wait_until_stable};
use crate::state::AppState;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(400);

/// Start a recursive filesystem watcher with debounce for in-progress writes.
pub fn start_watcher(app: AppHandle, state: Arc<AppState>) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();

    let mut watcher: RecommendedWatcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    {
        let settings = state.settings.lock();
        let path = PathBuf::from(&settings.watch_dir);
        if path.exists() {
            watcher
                .watch(&path, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }
    }

    *state.watcher.lock() = Some(watcher);

    thread::spawn(move || {
        let mut pending: HashMap<PathBuf, Instant> = HashMap::new();

        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(event) => {
                    let relevant = matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    );
                    if !relevant {
                        continue;
                    }
                    for path in event.paths {
                        if matches!(event.kind, EventKind::Remove(_)) {
                            remove_from_catalog(&app, &state, &path);
                            continue;
                        }
                        if is_video_file(&path) {
                            pending.insert(path, Instant::now());
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }

            let now = Instant::now();
            let ready: Vec<PathBuf> = pending
                .iter()
                .filter(|(_, t)| now.duration_since(**t) >= DEBOUNCE)
                .map(|(p, _)| p.clone())
                .collect();

            for path in ready {
                pending.remove(&path);
                if !path.exists() {
                    remove_from_catalog(&app, &state, &path);
                    continue;
                }
                if !wait_until_stable(&path, 3, 250) {
                    continue;
                }

                let session_id = state
                    .active_session
                    .lock()
                    .as_ref()
                    .map(|s| s.id.clone());

                let mut settings = state.settings.lock().clone();
                settings.ffmpeg_path = state.ffmpeg_bin();
                settings.ffprobe_path = state.ffprobe_bin();
                let app_data = state.app_data.clone();
                let result = {
                    let conn = state.db.lock();
                    catalog::index_file(
                        &conn,
                        &settings,
                        &app_data,
                        &path,
                        session_id.as_deref(),
                    )
                };

                if result.is_ok() {
                    let _ = app.emit("catalog-updated", ());
                }
            }
        }
    });

    Ok(())
}

/// Delete a recording from the catalog using the best path match available.
fn remove_from_catalog(app: &AppHandle, state: &AppState, path: &Path) {
    let raw = path.to_string_lossy().to_string();
    let conn = state.db.lock();
    let _ = crate::db::delete_recording_by_path(&conn, &raw);
    drop(conn);
    let _ = app.emit("catalog-updated", ());
}

/// Re-bind the watcher when the user changes `watch_dir`.
pub fn rewatch(state: &AppState) -> Result<(), String> {
    let settings = state.settings.lock();
    let path = PathBuf::from(&settings.watch_dir);
    let mut watcher_guard = state.watcher.lock();
    if let Some(watcher) = watcher_guard.as_mut() {
        if path.exists() {
            watcher
                .watch(&path, RecursiveMode::Recursive)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Convenience for AppHandle access during setup.
pub fn spawn_with_state(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<AppState>>().inner().clone();
    start_watcher(app.clone(), state)
}
