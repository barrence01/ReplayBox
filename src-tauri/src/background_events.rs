use crate::models::{Session, SessionEndedEvent};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Events produced by the folder watcher and game-process monitor.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BackgroundEvent {
    CatalogUpdated,
    SessionStarted {
        session: Session,
    },
    SessionEnded {
        session: Session,
        recording_count: usize,
    },
}

pub trait EventSink: Send + Sync {
    fn emit(&self, event: BackgroundEvent);
}

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: BackgroundEvent) {
        match event {
            BackgroundEvent::CatalogUpdated => {
                let _ = self.app.emit("catalog-updated", ());
            }
            BackgroundEvent::SessionStarted { session } => {
                let _ = self.app.emit("session-started", &session);
            }
            BackgroundEvent::SessionEnded {
                session,
                recording_count,
            } => {
                let _ = self.app.emit(
                    "session-ended",
                    &SessionEndedEvent {
                        session,
                        recording_count,
                    },
                );
            }
        }
    }
}

/// Appends events for the UI to drain; sends a desktop notification on session end.
pub struct FileEventSink {
    path: PathBuf,
}

impl FileEventSink {
    pub fn new(app_data: &Path) -> Arc<Self> {
        Arc::new(Self {
            path: events_path(app_data),
        })
    }
}

impl EventSink for FileEventSink {
    fn emit(&self, event: BackgroundEvent) {
        if let BackgroundEvent::SessionEnded {
            ref session,
            recording_count,
        } = event
        {
            let title = "ReplayBox";
            let body = format!(
                "Game closed — {} clip(s) ({})",
                recording_count,
                session.game_process.as_deref().unwrap_or("game")
            );
            let _ = Command::new("notify-send").arg(title).arg(&body).status();
        }
        let _ = append_event(&self.path, &event);
    }
}

pub fn events_path(app_data: &Path) -> PathBuf {
    app_data.join("daemon-events.jsonl")
}

pub fn pid_path(app_data: &Path) -> PathBuf {
    app_data.join("replayboxd.pid")
}

fn append_event(path: &Path, event: &BackgroundEvent) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(event).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{line}").map_err(|e| e.to_string())
}

/// Read and clear the daemon event log.
pub fn drain_events(app_data: &Path) -> Result<Vec<BackgroundEvent>, String> {
    let path = events_path(app_data);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<BackgroundEvent>(trimmed) {
            events.push(event);
        }
    }
    let _ = fs::write(&path, "");
    Ok(events)
}
