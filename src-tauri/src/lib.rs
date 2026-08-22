mod catalog;
mod commands;
mod db;
mod disk_space;
mod ffmpeg;
mod job_queue;
mod job_run_gate;
mod logging;
mod media_server;
mod models;
mod playback;
mod playback_cache;
mod preview_queue;
mod settings;
mod state;
mod tools;
mod tray_status;

use settings::{AppPaths, Settings};
use state::AppState;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;
use tray_status::TrayIconState;

struct TrayMenuState {
    pause_item: MenuItem<tauri::Wry>,
}

fn show_main_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        commands::resume_from_tray(app, state.inner());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn update_pause_menu_label(app: &AppHandle) {
    let Some(tray_menu) = app.try_state::<StdMutex<TrayMenuState>>() else {
        return;
    };
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let label = if state.job_run_gate.jobs_paused() {
        "Resume Jobs"
    } else {
        "Pause Jobs"
    };
    if let Ok(guard) = tray_menu.lock() {
        let _ = guard.pause_item.set_text(label);
    };
}

fn toggle_jobs_paused(app: &AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    let next = !state.job_run_gate.jobs_paused();
    state.set_jobs_paused(next);
    let _ = app.emit("jobs-paused-changed", next);
    update_pause_menu_label(app);
    tray_status::notify_queues_changed(app);
}

fn quit_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        commands::cleanup_on_quit(app, state.inner());
    }
    app.exit(0);
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let pause_i = MenuItem::with_id(app, "pause_jobs", "Pause Jobs", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &pause_i, &quit_i])?;

    app.manage(StdMutex::new(TrayMenuState {
        pause_item: pause_i,
    }));

    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("ReplayBox")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "pause_jobs" => toggle_jobs_paused(app),
            "quit" => quit_app(app),
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

    app.manage(StdMutex::new(TrayIconState::new(tray)));

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // single-instance must be registered first so a second launch is redirected.
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let paths = AppPaths::resolve(app)?;
            std::fs::create_dir_all(&paths.config_dir)?;
            std::fs::create_dir_all(&paths.data_dir)?;
            std::fs::create_dir_all(&paths.cache_dir)?;
            std::fs::create_dir_all(&paths.playback_cache_dir())?;
            logging::init_logging(&paths.log_dir)?;

            let mut settings = Settings::load(&paths.settings_path());
            if settings.ffmpeg_path.trim() == "ffmpeg" {
                settings.ffmpeg_path.clear();
            }
            if settings.ffprobe_path.trim() == "ffprobe" {
                settings.ffprobe_path.clear();
            }

            let resource_dir = tools::discover_resource_dir(app.path().resource_dir().ok());
            let conn = db::open_db(&paths.db_path())?;
            let state = AppState::new(paths.clone(), resource_dir, conn, settings.clone());
            playback_cache::run_cache_cleanup(
                &paths.playback_cache_dir(),
                &playback_cache::CleanupPolicy::from_settings(&settings),
            );

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
            commands::get_playback_cache_limits,
            commands::get_playback_cache_stats,
            commands::clear_playback_cache,
            commands::clear_all_cache,
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
            commands::get_playback_info,
            commands::get_job_status,
            commands::list_jobs,
            commands::list_preview_jobs,
            commands::dismiss_job,
            commands::dismiss_preview_job,
            commands::clear_finished_jobs,
            commands::clear_finished_preview_jobs,
            commands::cancel_job,
            commands::cancel_preview_job,
            commands::cancel_preview_for_recording,
            commands::get_jobs_paused,
            commands::set_jobs_paused,
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
                    if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                        commands::suspend_for_tray(app_handle, state.inner());
                    }
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
        });
}
