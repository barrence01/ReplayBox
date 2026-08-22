use crate::settings;
use std::path::Path;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

/// Initialize daily-rotated file logging under `{app_data}/logs/`.
pub fn init_logging(app_data: &Path) -> Result<(), String> {
    let logs = settings::logs_dir(app_data);
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;

    let file_appender = RollingFileAppender::new(Rotation::DAILY, &logs, "replaybox.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard));

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,replaybox=debug"));

    let file_layer = fmt::layer().with_writer(non_blocking).with_ansi(false);

    #[cfg(debug_assertions)]
    {
        let stderr_layer = fmt::layer().with_writer(std::io::stderr);
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .with(stderr_layer)
            .init();
    }

    #[cfg(not(debug_assertions))]
    {
        tracing_subscriber::registry()
            .with(filter)
            .with(file_layer)
            .init();
    }

    Ok(())
}
