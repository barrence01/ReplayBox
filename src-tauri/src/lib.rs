mod catalog;
mod commands;
mod db;
mod ffmpeg;
mod logging;
mod media_server;
mod models;
mod settings;
mod state;
mod tools;

use settings::{db_path, settings_path, thumbs_dir, Settings};
use state::AppState;
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("ReplayBox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            std::fs::create_dir_all(&app_data)?;
            std::fs::create_dir_all(thumbs_dir(&app_data))?;
            logging::init_logging(&app_data)?;

            let mut settings = Settings::load(&settings_path(&app_data));
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
                Err(e) => tracing::error!("media server failed to start: {e}"),
            }

            app.manage(state);

            if let Err(e) = setup_tray(app.handle()) {
                tracing::error!("tray setup failed: {e}");
            }

            {
                let state = app.state::<Arc<AppState>>();
                let launch = state.settings.lock().launch_on_startup;
                if let Err(e) = commands::sync_autostart_on_boot(app.handle(), launch) {
                    tracing::warn!("autostart sync: {e}");
                }
            }

            let handle = app.handle().clone();
            let state = handle.state::<Arc<AppState>>().inner().clone();
            if ffmpeg::binary_available(&state.ffprobe_bin()) {
                let _ = commands::spawn_catalog_scan(
                    handle,
                    state,
                    commands::ScanKind::Full,
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::check_watch_dir,
            commands::update_settings,
            commands::list_recordings,
            commands::get_recording,
            commands::recording_file_exists,
            commands::delete_recording,
            commands::resolve_copy_path,
            commands::rescan_library,
            commands::scan_folder,
            commands::check_tools,
            commands::nvenc_available,
            commands::resolved_tool_paths,
            commands::get_media_base_url,
            commands::get_job_status,
            commands::cancel_job,
            commands::start_trim,
            commands::start_compress,
        ])
        .build(tauri::generate_context!())
        .expect("error while building ReplayBox")
        .run(|app_handle, event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = event
            {
                if label == "main" {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
        });
}
