use crate::models::Recording;
use std::io::Read;
use std::path::Path;

const MP4_SCAN_LIMIT: usize = 64 * 1024;
const HIGH_BITRATE_BPS: f64 = 15_000_000.0;

/// How a recording should be delivered to the HTML5 player.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackStrategy {
    Direct,
    RemuxAudio,
    Transcode,
}

/// True when the MP4 has `mdat` before `moov` or `moov` is not in the file header.
pub fn mp4_needs_stream_remux(path: &Path) -> bool {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return true,
    };
    let mut buf = vec![0u8; MP4_SCAN_LIMIT];
    let n = match file.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return true,
    };
    buf.truncate(n);
    mp4_moov_after_mdat(&buf)
}

fn mp4_moov_after_mdat(data: &[u8]) -> bool {
    let mut offset = 0usize;
    let mut saw_moov = false;

    while offset + 8 <= data.len() {
        let size32 = u32::from_be_bytes(data[offset..offset + 4].try_into().unwrap()) as u64;
        let box_type = &data[offset + 4..offset + 8];

        let (box_size, header_size) = if size32 == 1 {
            if offset + 16 > data.len() {
                break;
            }
            let size64 = u64::from_be_bytes(data[offset + 8..offset + 16].try_into().unwrap());
            (size64, 16usize)
        } else if size32 == 0 {
            break;
        } else {
            (size32, 8usize)
        };

        if box_size < header_size as u64 {
            break;
        }

        if box_type == b"moov" {
            saw_moov = true;
        }
        if box_type == b"mdat" && !saw_moov {
            return true;
        }

        let advance = box_size.min((data.len() - offset) as u64) as usize;
        if advance == 0 {
            break;
        }
        offset += advance;
    }

    !saw_moov
}

fn estimated_bitrate_bps(recording: &Recording) -> Option<f64> {
    let size = recording.size_bytes? as f64;
    let duration_ms = recording.duration_ms?;
    if duration_ms <= 0.0 {
        return None;
    }
    Some(size * 8.0 / (duration_ms / 1000.0))
}

fn prefers_cache_remux(recording: &Recording) -> bool {
    if mp4_needs_stream_remux(Path::new(&recording.path)) {
        return true;
    }
    estimated_bitrate_bps(recording).is_some_and(|bps| bps > HIGH_BITRATE_BPS)
}

/// Stream-copy remux keeps sparse keyframes; WebKit scrubbing needs CFR transcode preview.
fn prefers_cache_transcode(recording: &Recording) -> bool {
    vfr_needs_transcode_preview(recording) || prefers_cache_remux(recording)
}

/// VFR MP4 in WebKitGTK seeks poorly with stream-copy remux; use CFR transcode preview.
fn vfr_needs_transcode_preview(recording: &Recording) -> bool {
    recording.is_vfr
}

/// Pick the lightest playback path the WebView is likely to support.
pub fn playback_strategy(
    recording: &Recording,
    force_fallback: bool,
    fallback_level: u8,
) -> PlaybackStrategy {
    if force_fallback {
        return fallback_strategy(recording, fallback_level);
    }

    let ext = Path::new(&recording.path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    let video = recording
        .video_codec
        .as_deref()
        .map(str::to_ascii_lowercase);
    let audio = recording
        .audio_codec
        .as_deref()
        .map(str::to_ascii_lowercase);

    if ext.as_deref() != Some("mp4") {
        return PlaybackStrategy::Transcode;
    }

    match video.as_deref() {
        Some("h264") | Some("avc1") => {}
        None => return PlaybackStrategy::Direct,
        _ => return PlaybackStrategy::Transcode,
    }

    if vfr_needs_transcode_preview(recording) {
        return PlaybackStrategy::Transcode;
    }

    match audio.as_deref() {
        Some("aac") | Some("mp3") | Some("mp4a") | None => {
            if prefers_cache_transcode(recording) {
                PlaybackStrategy::Transcode
            } else {
                PlaybackStrategy::Direct
            }
        }
        Some("opus") => PlaybackStrategy::RemuxAudio,
        _ => PlaybackStrategy::RemuxAudio,
    }
}

fn fallback_strategy(recording: &Recording, level: u8) -> PlaybackStrategy {
    if level >= 2 || prefers_cache_transcode(recording) {
        return PlaybackStrategy::Transcode;
    }

    let video = recording
        .video_codec
        .as_deref()
        .map(str::to_ascii_lowercase);

    match video.as_deref() {
        Some("h264") | Some("avc1") | None => PlaybackStrategy::RemuxAudio,
        _ => PlaybackStrategy::Transcode,
    }
}

pub fn build_media_url(base_url: &str, path: &str) -> String {
    let encoded = urlencoding::encode(path);
    format!("{base_url}/media?path={encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::Builder;

    fn recording_with_meta(
        codecs: (&str, &str),
        path: &str,
        size_bytes: Option<i64>,
        duration_ms: Option<f64>,
        is_vfr: bool,
    ) -> Recording {
        Recording {
            id: "id".into(),
            path: path.into(),
            filename: "clip.mp4".into(),
            dir: "/tmp".into(),
            size_bytes,
            duration_ms,
            width: Some(1920),
            height: Some(1080),
            video_codec: Some(codecs.0.into()),
            audio_codec: Some(codecs.1.into()),
            is_vfr,
            created_at: None,
            modified_at: None,
            thumbnail_path: None,
            session_id: None,
            indexed_at: "2026-01-01".into(),
        }
    }

    fn recording(codecs: (&str, &str), path: &str) -> Recording {
        recording_with_meta(codecs, path, None, Some(60_000.0), false)
    }

    fn write_mp4_atoms(atoms: &[(&[u8], &[u8])]) -> tempfile::NamedTempFile {
        let mut tmp = Builder::new().suffix(".mp4").tempfile().unwrap();
        for (typ, payload) in atoms {
            let size = (8 + payload.len()) as u32;
            tmp.write_all(&size.to_be_bytes()).unwrap();
            tmp.write_all(typ).unwrap();
            tmp.write_all(payload).unwrap();
        }
        tmp
    }

    #[test]
    fn mp4_mdat_before_moov_needs_remux() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"mdat", &[0; 16]),
        ]);
        assert!(mp4_needs_stream_remux(tmp.path()));
    }

    #[test]
    fn mp4_moov_before_mdat_is_streamable() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 16]),
            (b"mdat", &[0; 16]),
        ]);
        assert!(!mp4_needs_stream_remux(tmp.path()));
    }

    #[test]
    fn high_bitrate_h264_aac_prefers_transcode_preview() {
        let rec = recording_with_meta(
            ("h264", "aac"),
            "/v/faststart.mp4",
            Some(800_000_000),
            Some(167_200.0),
            false,
        );
        assert!(estimated_bitrate_bps(&rec).unwrap() > HIGH_BITRATE_BPS);
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn high_bitrate_force_fallback_level_one_is_transcode() {
        let rec = recording_with_meta(
            ("h264", "aac"),
            "/v/faststart.mp4",
            Some(800_000_000),
            Some(167_200.0),
            false,
        );
        assert_eq!(playback_strategy(&rec, true, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn moov_at_end_prefers_transcode_preview() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"mdat", &[0; 16]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn h264_aac_mp4_is_direct_without_remux_signals() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn h264_opus_mp4_is_remux() {
        let rec = recording(("h264", "opus"), "/v/a.mp4");
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::RemuxAudio);
    }

    #[test]
    fn hevc_is_transcode() {
        let rec = recording(("hevc", "aac"), "/v/a.mp4");
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn non_mp4_is_transcode() {
        let rec = recording(("h264", "aac"), "/v/a.mkv");
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn force_fallback_level_one_is_remux() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(playback_strategy(&rec, true, 1), PlaybackStrategy::RemuxAudio);
    }

    #[test]
    fn force_fallback_level_two_is_transcode() {
        let rec = recording(("h264", "aac"), "/v/a.mp4");
        assert_eq!(playback_strategy(&rec, true, 2), PlaybackStrategy::Transcode);
    }

    #[test]
    fn force_fallback_hevc_level_one_is_transcode() {
        let rec = recording(("hevc", "aac"), "/v/a.mp4");
        assert_eq!(playback_strategy(&rec, true, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn mp4_moov_after_mdat_detects_non_streamable_layout() {
        assert!(mp4_moov_after_mdat(b"\x00\x00\x00\x14ftypisom\x00\x00\x00\x00\x00\x00\x00\x10mdat"));
        let streamable = [
            0, 0, 0, 16, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm', b'0', b'0', b'0', b'0',
            0, 0, 0, 16, b'm', b'o', b'o', b'v', 0, 0, 0, 0, 0, 0, 0, 0,
            0, 0, 0, 16, b'm', b'd', b'a', b't', 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert!(!mp4_moov_after_mdat(&streamable));
    }

    #[test]
    fn vfr_h264_aac_mp4_prefers_transcode_preview() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.is_vfr = true;
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn vfr_force_fallback_level_one_is_transcode() {
        let rec = recording(("h264", "aac"), "/v/a.mp4");
        let mut rec = rec;
        rec.is_vfr = true;
        assert_eq!(playback_strategy(&rec, true, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn media_url_includes_path() {
        let url = super::build_media_url("http://127.0.0.1:1", "/a/b.mp4");
        assert!(url.contains("/media?path="));
    }
}
