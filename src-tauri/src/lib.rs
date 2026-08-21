mod catalog;
mod commands;
mod db;
mod ffmpeg;
mod game_monitor;
mod media_server;
mod models;
mod settings;
mod state;
mod tools;
mod watcher;

use settings::{db_path, settings_path, thumbs_dir, Settings};
use state::AppState;
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data)?;
            std::fs::create_dir_all(thumbs_dir(&app_data))?;

            let mut settings = Settings::load(&settings_path(&app_data));
            // Migrate legacy PATH defaults to auto (bundled-first).
            if settings.ffmpeg_path.trim() == "ffmpeg" {
                settings.ffmpeg_path.clear();
            }
            if settings.ffprobe_path.trim() == "ffprobe" {
                settings.ffprobe_path.clear();
            }

            let resource_dir = tools::discover_resource_dir(app.path().resource_dir().ok());
            let conn = db::open_db(&db_path(&app_data))?;
            let state = AppState::new(app_data, resource_dir, conn, settings);

            match media_server::start(state.clone()) {
                Ok(url) => {
                    *state.media_base_url.lock() = Some(url);
                }
                Err(e) => eprintln!("media server failed to start: {e}"),
            }

            app.manage(state);

            watcher::spawn_with_state(&app.handle())?;
            game_monitor::spawn_with_state(&app.handle());

            // Initial library scan on a background thread.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let state = handle.state::<Arc<AppState>>();
                let mut settings = state.settings.lock().clone();
                settings.ffmpeg_path = state.ffmpeg_bin();
                settings.ffprobe_path = state.ffprobe_bin();
                if ffmpeg::binary_available(&settings.ffprobe_path) {
                    let session_id = state
                        .active_session
                        .lock()
                        .as_ref()
                        .map(|s| s.id.clone());
                    let conn = state.db.lock();
                    let _ = catalog::scan_library(
                        &conn,
                        &settings,
                        &state.app_data,
                        session_id.as_deref(),
                    );
                    let _ = handle.emit("catalog-updated", ());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::update_settings,
            commands::list_recordings,
            commands::list_session_recordings,
            commands::get_recording,
            commands::get_active_session,
            commands::rescan_library,
            commands::check_tools,
            commands::nvenc_available,
            commands::resolved_tool_paths,
            commands::get_media_base_url,
            commands::get_job_status,
            commands::cancel_job,
            commands::start_trim,
            commands::start_compress,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ReplayBox");
}
