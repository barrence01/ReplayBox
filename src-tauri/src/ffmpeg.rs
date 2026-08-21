use serde::Deserialize;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
pub struct ProbeInfo {
    pub duration_ms: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub is_vfr: bool,
}

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Option<Vec<Value>>,
    format: Option<Value>,
}

/// Called with a fraction in `[0.0, 1.0)` while ffmpeg runs.
pub type ProgressFn = Arc<dyn Fn(f64) + Send + Sync>;

/// Probe media metadata with timestamps; VFR is inferred from frame-rate fields.
pub fn probe(ffprobe: &str, path: &Path) -> Result<ProbeInfo, String> {
    let output = Command::new(ffprobe)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path.to_str().ok_or("Invalid path")?,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe ({ffprobe}): {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let parsed: FfprobeOutput =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;

    let mut info = ProbeInfo {
        duration_ms: None,
        width: None,
        height: None,
        video_codec: None,
        audio_codec: None,
        is_vfr: false,
    };

    if let Some(format) = &parsed.format {
        if let Some(dur) = format.get("duration").and_then(|v| v.as_str()) {
            if let Ok(secs) = dur.parse::<f64>() {
                info.duration_ms = Some(secs * 1000.0);
            }
        }
    }

    if let Some(streams) = &parsed.streams {
        for stream in streams {
            let codec_type = stream
                .get("codec_type")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            match codec_type {
                "video" if info.video_codec.is_none() => {
                    info.video_codec = stream
                        .get("codec_name")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                    info.width = stream.get("width").and_then(|v| v.as_i64());
                    info.height = stream.get("height").and_then(|v| v.as_i64());

                    if info.duration_ms.is_none() {
                        if let Some(dur) = stream.get("duration").and_then(|v| v.as_str()) {
                            if let Ok(secs) = dur.parse::<f64>() {
                                info.duration_ms = Some(secs * 1000.0);
                            }
                        }
                    }

                    let avg = stream
                        .get("avg_frame_rate")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0/0");
                    let r = stream
                        .get("r_frame_rate")
                        .and_then(|v| v.as_str())
                        .unwrap_or("0/0");
                    info.is_vfr = avg != r && avg != "0/0" && r != "0/0";
                }
                "audio" if info.audio_codec.is_none() => {
                    info.audio_codec = stream
                        .get("codec_name")
                        .and_then(|v| v.as_str())
                        .map(str::to_string);
                }
                _ => {}
            }
        }
    }

    Ok(info)
}

/// Extract a single-frame thumbnail at a timestamp (seconds), not a frame index.
pub fn generate_thumbnail(
    ffmpeg: &str,
    input: &Path,
    output: &Path,
    seek_secs: f64,
) -> Result<(), String> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let seek = format!("{:.3}", seek_secs.max(0.0));
    let status = Command::new(ffmpeg)
        .args([
            "-y",
            "-ss",
            &seek,
            "-i",
            input.to_str().ok_or("Invalid input path")?,
            "-frames:v",
            "1",
            "-q:v",
            "3",
            output.to_str().ok_or("Invalid output path")?,
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("Failed to run ffmpeg ({ffmpeg}): {e}"))?;

    if !status.success() {
        return Err("ffmpeg thumbnail generation failed".into());
    }
    Ok(())
}

/// Precise trim: re-encode with time-based trim filters; preserves VFR (no -r).
pub fn precise_trim(
    ffmpeg: &str,
    input: &Path,
    output: &Path,
    start_secs: f64,
    end_secs: f64,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
    on_progress: Option<ProgressFn>,
) -> Result<(), String> {
    let vf = format!("trim=start={start_secs}:end={end_secs},setpts=PTS-STARTPTS");
    let af = format!("atrim=start={start_secs}:end={end_secs},asetpts=PTS-STARTPTS");
    let duration_secs = (end_secs - start_secs).max(0.001);

    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-i",
            input.to_str().ok_or("Invalid input")?,
            "-vf",
            &vf,
            "-af",
            &af,
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-preset",
            "medium",
            "-c:a",
            "aac",
            output.to_str().ok_or("Invalid output")?,
        ],
        child_slot,
        duration_secs,
        on_progress,
    )
}

/// Fast trim via stream copy. May cut on keyframes — not frame-accurate.
pub fn fast_trim(
    ffmpeg: &str,
    input: &Path,
    output: &Path,
    start_secs: f64,
    end_secs: f64,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
    on_progress: Option<ProgressFn>,
) -> Result<(), String> {
    let start = format!("{start_secs:.3}");
    let end = format!("{end_secs:.3}");
    let duration_secs = (end_secs - start_secs).max(0.001);

    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-ss",
            &start,
            "-to",
            &end,
            "-i",
            input.to_str().ok_or("Invalid input")?,
            "-c",
            "copy",
            output.to_str().ok_or("Invalid output")?,
        ],
        child_slot,
        duration_secs,
        on_progress,
    )
}

/// Re-encode to H.264/AAC in an MP4 container (browser-friendly preview).
pub fn compress(
    ffmpeg: &str,
    input: &Path,
    output: &Path,
    crf: u8,
    use_nvenc: bool,
    duration_secs: f64,
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
    on_progress: Option<ProgressFn>,
) -> Result<(), String> {
    let crf_s = crf.to_string();
    let out = output.to_str().ok_or("Invalid output")?;
    let inp = input.to_str().ok_or("Invalid input")?;

    if use_nvenc && encoder_available(ffmpeg, "h264_nvenc") {
        run_ffmpeg(
            ffmpeg,
            &[
                "-y",
                "-i",
                inp,
                "-c:v",
                "h264_nvenc",
                "-cq",
                &crf_s,
                "-preset",
                "p4",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                out,
            ],
            child_slot,
            duration_secs,
            on_progress,
        )
    } else {
        run_ffmpeg(
            ffmpeg,
            &[
                "-y",
                "-i",
                inp,
                "-c:v",
                "libx264",
                "-crf",
                &crf_s,
                "-preset",
                "medium",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                out,
            ],
            child_slot,
            duration_secs,
            on_progress,
        )
    }
}

pub fn encoder_available(ffmpeg: &str, name: &str) -> bool {
    Command::new(ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(name))
        .unwrap_or(false)
}

pub fn binary_available(bin: &str) -> bool {
    Command::new(bin)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn run_ffmpeg(
    ffmpeg: &str,
    args: &[&str],
    child_slot: Option<Arc<Mutex<Option<u32>>>>,
    duration_secs: f64,
    on_progress: Option<ProgressFn>,
) -> Result<(), String> {
    let mut child = Command::new(ffmpeg)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run ffmpeg ({ffmpeg}): {e}"))?;

    if let Some(slot) = &child_slot {
        *slot.lock().unwrap() = Some(child.id());
    }

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "ffmpeg stderr unavailable".to_string())?;

    let mut err_buf = String::new();
    let reader = BufReader::new(stderr);
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        err_buf.push_str(&line);
        err_buf.push('\n');

        if let (Some(cb), Some(secs)) = (&on_progress, parse_ffmpeg_time_secs(&line)) {
            if duration_secs > 0.0 && last_emit.elapsed() >= Duration::from_millis(250) {
                let fraction = (secs / duration_secs).clamp(0.0, 0.99);
                cb(fraction);
                last_emit = Instant::now();
            }
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("ffmpeg wait failed: {e}"))?;

    if let Some(slot) = &child_slot {
        *slot.lock().unwrap() = None;
    }

    if !status.success() {
        return Err(format!("ffmpeg failed: {err_buf}"));
    }
    Ok(())
}

/// Parse `time=HH:MM:SS.xx` from an ffmpeg stderr line.
fn parse_ffmpeg_time_secs(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let token = rest.split_whitespace().next()?;
    if token.starts_with("N/A") {
        return None;
    }
    let parts: Vec<&str> = token.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let hours: f64 = parts[0].parse().ok()?;
    let mins: f64 = parts[1].parse().ok()?;
    let secs: f64 = parts[2].parse().ok()?;
    Some(hours * 3600.0 + mins * 60.0 + secs)
}

/// Build a sibling output path using the source extension (e.g. clip_trimmed.mkv).
pub fn sibling_output(input: &Path, suffix: &str) -> PathBuf {
    let ext = input
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    sibling_output_with_ext(input, suffix, ext)
}

/// Build a sibling output path with an explicit extension.
pub fn sibling_output_with_ext(input: &Path, suffix: &str, ext: &str) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    input
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}_{suffix}.{ext}"))
}

/// Default copy destination for trim (`trimmed`) or compress (`compressed` → mp4).
pub fn default_copy_dest(input: &Path, kind: &str) -> PathBuf {
    match kind {
        "compressed" => sibling_output_with_ext(input, "compressed", "mp4"),
        _ => sibling_output(input, "trimmed"),
    }
}

/// Next free numbered sibling: `file.ext` → `file_2.ext`, `file_3.ext`, …
pub fn next_unique_sibling(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("mp4");
    let mut n = 2u32;
    loop {
        let candidate = parent.join(format!("{stem}_{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        n = n.saturating_add(1);
    }
}

/// Resolve the final output path for a job given mode and copy collision policy.
pub fn resolve_job_dest(
    original: &Path,
    output_mode: &str,
    kind: &str,
    force_mp4: bool,
    copy_collision: Option<&str>,
) -> PathBuf {
    if output_mode == "replace" {
        if force_mp4 && !is_mp4_container(original) {
            stem_with_mp4(original)
        } else {
            original.to_path_buf()
        }
    } else {
        let default = default_copy_dest(original, kind);
        match copy_collision {
            Some("unique") => next_unique_sibling(&default),
            _ => default,
        }
    }
}

/// True when the path is already an MP4-family container suitable for in-place replace.
pub fn is_mp4_container(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("mp4") || e.eq_ignore_ascii_case("m4v"))
        .unwrap_or(false)
}

/// Destination path for a replace-to-mp4 when the original is not MP4.
pub fn stem_with_mp4(input: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    input
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{stem}.mp4"))
}

/// Atomically replace `original` with `temp` (rename after write).
pub fn atomic_replace(temp: &Path, original: &Path) -> Result<(), String> {
    let backup = original.with_extension(format!(
        "{}.bak",
        original
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("mp4")
    ));
    if original.exists() {
        std::fs::rename(original, &backup).map_err(|e| e.to_string())?;
    }
    match std::fs::rename(temp, original) {
        Ok(()) => {
            let _ = std::fs::remove_file(&backup);
            Ok(())
        }
        Err(e) => {
            if backup.exists() {
                let _ = std::fs::rename(&backup, original);
            }
            Err(e.to_string())
        }
    }
}
