use crate::db;
use crate::models::{Session, SessionEndedEvent};
use crate::state::{ActiveSession, AppState};
use chrono::Utc;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

/// Poll `/proc` for configured game process names and manage session lifecycle.
pub fn start_monitor(app: AppHandle, state: Arc<AppState>) {
    thread::spawn(move || loop {
        let names = state.settings.lock().game_process_names.clone();
        if names.is_empty() {
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        let matched = find_matching_process(&names);
        let active_snapshot = state.active_session.lock().clone();

        match (active_snapshot, matched) {
            (None, Some(proc_name)) => {
                let session = Session {
                    id: Uuid::new_v4().to_string(),
                    started_at: Utc::now().to_rfc3339(),
                    ended_at: None,
                    game_process: Some(proc_name.clone()),
                };
                {
                    let conn = state.db.lock();
                    let _ = db::insert_session(&conn, &session);
                }
                *state.active_session.lock() = Some(ActiveSession {
                    id: session.id.clone(),
                    game_process: proc_name,
                });
                let _ = app.emit("session-started", &session);
            }
            (Some(active), None) => {
                let ended_at = Utc::now().to_rfc3339();
                {
                    let conn = state.db.lock();
                    let _ = db::end_session(&conn, &active.id, &ended_at);
                }
                *state.active_session.lock() = None;

                let (session, recording_count) = {
                    let conn = state.db.lock();
                    let session = db::get_session(&conn, &active.id).ok().flatten().unwrap_or(
                        Session {
                            id: active.id.clone(),
                            started_at: String::new(),
                            ended_at: Some(ended_at.clone()),
                            game_process: Some(active.game_process.clone()),
                        },
                    );
                    let recording_count = db::list_session_recordings(&conn, &active.id)
                        .map(|v| v.len())
                        .unwrap_or(0);
                    (session, recording_count)
                };

                let _ = app.emit(
                    "session-ended",
                    &SessionEndedEvent {
                        session,
                        recording_count,
                    },
                );
            }
            _ => {}
        }

        thread::sleep(Duration::from_secs(1));
    });
}

pub fn spawn_with_state(app: &AppHandle) {
    let state = app.state::<Arc<AppState>>().inner().clone();
    start_monitor(app.clone(), state);
}

fn find_matching_process(names: &[String]) -> Option<String> {
    let proc_dir = Path::new("/proc");
    let entries = fs::read_dir(proc_dir).ok()?;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        let pid_path = entry.path();
        let comm = fs::read_to_string(pid_path.join("comm"))
            .unwrap_or_default()
            .trim()
            .to_string();
        let cmdline = fs::read(pid_path.join("cmdline"))
            .map(|b| String::from_utf8_lossy(&b).replace('\0', " "))
            .unwrap_or_default();

        for pattern in names {
            let p = pattern.to_lowercase();
            if comm.to_lowercase().contains(&p) || cmdline.to_lowercase().contains(&p) {
                return Some(if !comm.is_empty() {
                    comm
                } else {
                    pattern.clone()
                });
            }
        }
    }
    None
}
