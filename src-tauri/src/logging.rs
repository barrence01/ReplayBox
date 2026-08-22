use chrono::{NaiveDate, Utc};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

const LOG_BASENAME: &str = "replaybox.log";
const FFMPEG_LOG_BASENAME: &str = "ffmpeg.log";
const LOG_BASENAMES: &[&str] = &[LOG_BASENAME, FFMPEG_LOG_BASENAME];
const LOG_RETENTION_DAYS: i64 = 7;

static FFMPEG_LOG: OnceLock<Mutex<FfmpegLogWriter>> = OnceLock::new();

struct FfmpegLogWriter {
    appender: RollingFileAppender,
    pending: Vec<u8>,
}

impl FfmpegLogWriter {
    fn append(&mut self, data: &[u8]) -> std::io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.pending.extend_from_slice(data);
        for byte in &mut self.pending {
            if *byte == b'\r' {
                *byte = b'\n';
            }
        }
        while let Some(newline) = self.pending.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&self.pending[..newline]).into_owned();
            self.pending.drain(..=newline);
            if line.trim().is_empty() {
                continue;
            }
            self.write_entry(&line)?;
        }
        Ok(())
    }

    fn flush_pending(&mut self) -> std::io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let line = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        if line.trim().is_empty() {
            return Ok(());
        }
        self.write_entry(&line)
    }

    fn write_entry(&mut self, line: &str) -> std::io::Result<()> {
        write!(self.appender, "{}  INFO ffmpeg: {line}\n", log_timestamp())
    }
}

fn log_timestamp() -> String {
    let now = Utc::now();
    format!(
        "{}.{:06}Z",
        now.format("%Y-%m-%dT%H:%M:%S"),
        now.timestamp_subsec_micros()
    )
}

/// Append raw FFmpeg stderr bytes to the dedicated log file.
pub fn append_ffmpeg_log_bytes(data: &[u8]) {
    if let Some(writer) = FFMPEG_LOG.get() {
        if let Ok(mut guard) = writer.lock() {
            let _ = guard.append(data);
            let _ = guard.appender.flush();
        }
    }
}

/// Flush any buffered stderr without a trailing newline (end of FFmpeg process).
pub fn flush_ffmpeg_log() {
    if let Some(writer) = FFMPEG_LOG.get() {
        if let Ok(mut guard) = writer.lock() {
            let _ = guard.flush_pending();
            let _ = guard.appender.flush();
        }
    }
}

/// Initialize daily-rotated file logging under the Tauri app log directory.
pub fn init_logging(log_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(log_dir).map_err(|e| e.to_string())?;
    prune_old_logs(log_dir)?;

    let file_appender = RollingFileAppender::new(Rotation::DAILY, log_dir, LOG_BASENAME);
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    Box::leak(Box::new(guard));

    let ffmpeg_appender =
        RollingFileAppender::new(Rotation::DAILY, log_dir, FFMPEG_LOG_BASENAME);
    let _ = FFMPEG_LOG.set(Mutex::new(FfmpegLogWriter {
        appender: ffmpeg_appender,
        pending: Vec::new(),
    }));

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
    for basename in LOG_BASENAMES {
        if name == *basename {
            return None;
        }
        if let Some(suffix) = name.strip_prefix(&format!("{basename}.")) {
            return NaiveDate::parse_from_str(suffix, "%Y-%m-%d").ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use std::path::PathBuf;

    fn touch_rotated_log(dir: &Path, basename: &str, date: NaiveDate) {
        let path = dir.join(format!("{basename}.{date}"));
        fs::write(path, "line\n").unwrap();
    }

    #[test]
    fn prune_old_logs_removes_files_older_than_retention() {
        let dir = tempfile::tempdir().unwrap();
        let today = Utc::now().date_naive();
        touch_rotated_log(dir.path(), LOG_BASENAME, today);
        touch_rotated_log(
            dir.path(),
            LOG_BASENAME,
            today - Duration::days(6),
        );
        touch_rotated_log(
            dir.path(),
            LOG_BASENAME,
            today - Duration::days(7),
        );
        touch_rotated_log(
            dir.path(),
            LOG_BASENAME,
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
    fn prune_old_logs_removes_rotated_ffmpeg_logs() {
        let dir = tempfile::tempdir().unwrap();
        let today = Utc::now().date_naive();
        touch_rotated_log(dir.path(), FFMPEG_LOG_BASENAME, today);
        touch_rotated_log(
            dir.path(),
            FFMPEG_LOG_BASENAME,
            today - Duration::days(6),
        );
        touch_rotated_log(
            dir.path(),
            FFMPEG_LOG_BASENAME,
            today - Duration::days(7),
        );
        fs::write(dir.path().join(FFMPEG_LOG_BASENAME), "active\n").unwrap();

        prune_old_logs(dir.path()).unwrap();

        assert!(dir.path().join(FFMPEG_LOG_BASENAME).is_file());
        assert!(
            dir.path()
                .join(format!("{FFMPEG_LOG_BASENAME}.{today}"))
                .is_file()
        );
        assert!(
            !dir.path()
                .join(format!(
                    "{FFMPEG_LOG_BASENAME}.{}",
                    today - Duration::days(7)
                ))
                .exists()
        );
    }

    #[test]
    fn log_timestamp_matches_tracing_style() {
        let ts = log_timestamp();
        assert!(ts.ends_with('Z'));
        assert!(ts.contains('T'));
        assert_eq!(ts.matches('.').count(), 1);
    }

    #[test]
    fn ffmpeg_log_writer_prefixes_complete_lines() {
        let dir = tempfile::tempdir().unwrap();
        let appender =
            RollingFileAppender::new(Rotation::DAILY, dir.path(), FFMPEG_LOG_BASENAME);
        let mut writer = FfmpegLogWriter {
            appender,
            pending: Vec::new(),
        };
        writer.append(b"Input #0\nframe=1\rframe=2\n").unwrap();
        writer.flush_pending().unwrap();
        writer.appender.flush().unwrap();

        let today = Utc::now().format("%Y-%m-%d");
        let path = dir.path().join(format!("{FFMPEG_LOG_BASENAME}.{today}"));
        let contents = fs::read_to_string(path).unwrap();
        assert!(contents.contains("  INFO ffmpeg: Input #0"));
        assert!(contents.contains("  INFO ffmpeg: frame=1"));
        assert!(contents.contains("  INFO ffmpeg: frame=2"));
    }

    #[test]
    fn log_file_date_parses_rotated_names() {
        let path = PathBuf::from("/tmp/replaybox.log.2026-08-15");
        assert_eq!(
            log_file_date(&path),
            NaiveDate::from_ymd_opt(2026, 8, 15)
        );
        let path = PathBuf::from("/tmp/ffmpeg.log.2026-08-15");
        assert_eq!(
            log_file_date(&path),
            NaiveDate::from_ymd_opt(2026, 8, 15)
        );
        assert!(log_file_date(&PathBuf::from("/tmp/replaybox.log")).is_none());
        assert!(log_file_date(&PathBuf::from("/tmp/ffmpeg.log")).is_none());
    }
}
