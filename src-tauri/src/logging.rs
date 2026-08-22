use chrono::{NaiveDate, Utc};
use std::fs;
use std::path::Path;
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const LOG_BASENAME: &str = "replaybox.log";
const LOG_RETENTION_DAYS: i64 = 7;

/// Initialize daily-rotated file logging under the Tauri app log directory.
pub fn init_logging(log_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(log_dir).map_err(|e| e.to_string())?;
    prune_old_logs(log_dir)?;

    let file_appender = RollingFileAppender::new(Rotation::DAILY, log_dir, LOG_BASENAME);
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard));

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));

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

fn prune_old_logs(log_dir: &Path) -> Result<(), String> {
    let today = Utc::now().date_naive();
    for entry in fs::read_dir(log_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(date) = log_file_date(&path) else {
            continue;
        };
        if (today - date).num_days() >= LOG_RETENTION_DAYS {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn log_file_date(path: &Path) -> Option<NaiveDate> {
    let name = path.file_name()?.to_str()?;
    if name == LOG_BASENAME {
        return None;
    }
    let suffix = name.strip_prefix(&format!("{LOG_BASENAME}."))?;
    NaiveDate::parse_from_str(suffix, "%Y-%m-%d").ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use chrono::Duration;

    fn touch_log(dir: &Path, date: NaiveDate) {
        let path = dir.join(format!("{LOG_BASENAME}.{date}"));
        fs::write(path, "line\n").unwrap();
    }

    #[test]
    fn prune_old_logs_removes_files_older_than_retention() {
        let dir = tempfile::tempdir().unwrap();
        let today = Utc::now().date_naive();
        touch_log(dir.path(), today);
        touch_log(
            dir.path(),
            today - Duration::days(6),
        );
        touch_log(
            dir.path(),
            today - Duration::days(7),
        );
        touch_log(
            dir.path(),
            today - Duration::days(30),
        );
        fs::write(dir.path().join(LOG_BASENAME), "active\n").unwrap();

        prune_old_logs(dir.path()).unwrap();

        assert!(dir.path().join(LOG_BASENAME).is_file());
        assert!(
            dir
                .path()
                .join(format!("{LOG_BASENAME}.{today}"))
                .is_file()
        );
        assert!(
            dir.path()
                .join(format!(
                    "{LOG_BASENAME}.{}",
                    today - Duration::days(6)
                ))
                .is_file()
        );
        assert!(
            !dir.path()
                .join(format!(
                    "{LOG_BASENAME}.{}",
                    today - Duration::days(7)
                ))
                .exists()
        );
        assert!(
            !dir.path()
                .join(format!(
                    "{LOG_BASENAME}.{}",
                    today - Duration::days(30)
                ))
                .exists()
        );
    }

    #[test]
    fn log_file_date_parses_rotated_name() {
        let path = PathBuf::from("/tmp/replaybox.log.2026-08-15");
        assert_eq!(
            log_file_date(&path),
            NaiveDate::from_ymd_opt(2026, 8, 15)
        );
        assert!(log_file_date(&PathBuf::from("/tmp/replaybox.log")).is_none());
    }
}
