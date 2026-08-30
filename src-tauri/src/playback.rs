use crate::models::Recording;
use std::io::Read;
use std::path::Path;

const MP4_SCAN_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackStrategy {
    Direct,
    StreamCopy,
    Transcode,
}

pub fn strategy_sidecar_name(strategy: PlaybackStrategy) -> &'static str {
    match strategy {
        PlaybackStrategy::Direct => "direct",
        PlaybackStrategy::StreamCopy => "stream_copy",
        PlaybackStrategy::Transcode => "transcode",
    }
}

pub fn sidecar_strategy_rank(name: &str) -> u8 {
    match name {
        "transcode" => 2,
        "stream_copy" | "remux" => 1,
        _ => 0,
    }
}

pub fn is_h264_video(codec: Option<&str>) -> bool {
    matches!(
        codec.map(str::to_ascii_lowercase).as_deref(),
        Some("h264") | Some("avc1")
    )
}

pub fn is_browser_native_audio(codec: Option<&str>) -> bool {
    matches!(
        codec.map(str::to_ascii_lowercase).as_deref(),
        Some("aac") | Some("mp3") | Some("mp4a") | None
    )
}

pub fn is_direct_playback_audio(codec: Option<&str>) -> bool {
    is_browser_native_audio(codec)
        || matches!(codec.map(str::to_ascii_lowercase).as_deref(), Some("opus"))
}

#[allow(dead_code)]
pub fn audio_copy_compatible(audio_codec: Option<&str>) -> bool {
    is_browser_native_audio(audio_codec)
}

#[allow(dead_code)]
pub fn needs_container_fixup(path: &Path, ext: Option<&str>) -> bool {
    if ext != Some("mp4") {
        return true;
    }
    mp4_needs_stream_remux(path)
}

#[allow(dead_code)]
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

pub fn select_initial_strategy(recording: &Recording) -> PlaybackStrategy {
    let path = Path::new(&recording.path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let ext_ref = ext.as_deref();

    let video = recording
        .video_codec
        .as_deref()
        .map(str::to_ascii_lowercase);

    match video.as_deref() {
        None => return PlaybackStrategy::Direct,
        Some(codec) if is_h264_video(Some(codec)) => {}
        _ => return PlaybackStrategy::Transcode,
    }

    if ext_ref != Some("mp4") {
        return PlaybackStrategy::StreamCopy;
    }

    PlaybackStrategy::Direct
}

pub fn select_fallback_strategy(recording: &Recording, level: u8) -> PlaybackStrategy {
    if level >= 2 {
        return PlaybackStrategy::Transcode;
    }

    if is_h264_video(recording.video_codec.as_deref()) {
        PlaybackStrategy::StreamCopy
    } else {
        PlaybackStrategy::Transcode
    }
}

pub fn playback_strategy(
    recording: &Recording,
    force_fallback: bool,
    fallback_level: u8,
) -> PlaybackStrategy {
    if force_fallback {
        return select_fallback_strategy(recording, fallback_level);
    }

    select_initial_strategy(recording)
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
            filename: Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("clip.mp4")
                .into(),
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
    fn high_bitrate_h264_aac_is_direct() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let rec = recording_with_meta(
            ("h264", "aac"),
            tmp.path().to_str().unwrap(),
            Some(800_000_000),
            Some(167_200.0),
            false,
        );
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn high_bitrate_force_fallback_level_one_is_stream_copy() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let rec = recording_with_meta(
            ("h264", "aac"),
            tmp.path().to_str().unwrap(),
            Some(800_000_000),
            Some(167_200.0),
            false,
        );
        assert_eq!(
            playback_strategy(&rec, true, 1),
            PlaybackStrategy::StreamCopy
        );
    }

    #[test]
    fn moov_at_end_h264_aac_is_direct() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"mdat", &[0; 16]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn h264_aac_mp4_is_direct_without_fixup_signals() {
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
    fn h264_opus_faststart_mp4_is_direct() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let rec = recording(("h264", "opus"), tmp.path().to_str().unwrap());
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn h264_opus_moov_at_end_is_direct() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"mdat", &[0; 16]),
        ]);
        let rec = recording(("h264", "opus"), tmp.path().to_str().unwrap());
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn h264_exotic_audio_mp4_is_direct() {
        let rec = recording(("h264", "pcm_s16le"), "/v/a.mp4");
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn hevc_is_transcode() {
        let rec = recording(("hevc", "aac"), "/v/a.mp4");
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Transcode);
    }

    #[test]
    fn mkv_h264_aac_is_stream_copy() {
        let rec = recording(("h264", "aac"), "/v/a.mkv");
        assert_eq!(
            playback_strategy(&rec, false, 1),
            PlaybackStrategy::StreamCopy
        );
    }

    #[test]
    fn force_fallback_level_one_is_stream_copy() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(
            playback_strategy(&rec, true, 1),
            PlaybackStrategy::StreamCopy
        );
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
    fn vfr_h264_aac_mp4_is_direct() {
        let tmp = write_mp4_atoms(&[
            (b"ftyp", b"isom"),
            (b"moov", &[0; 8]),
            (b"mdat", &[0; 8]),
        ]);
        let mut rec = recording(("h264", "aac"), tmp.path().to_str().unwrap());
        rec.is_vfr = true;
        rec.size_bytes = Some(1_000_000);
        rec.duration_ms = Some(60_000.0);
        assert_eq!(playback_strategy(&rec, false, 1), PlaybackStrategy::Direct);
    }

    #[test]
    fn vfr_force_fallback_level_one_is_stream_copy() {
        let rec = recording(("h264", "aac"), "/v/a.mp4");
        let mut rec = rec;
        rec.is_vfr = true;
        assert_eq!(
            playback_strategy(&rec, true, 1),
            PlaybackStrategy::StreamCopy
        );
    }

    #[test]
    fn sidecar_strategy_rank_accepts_legacy_remux() {
        assert_eq!(sidecar_strategy_rank("remux"), sidecar_strategy_rank("stream_copy"));
    }

    #[test]
    fn media_url_includes_path() {
        let url = super::build_media_url("http://127.0.0.1:1", "/a/b.mp4");
        assert!(url.contains("/media?path="));
    }
}
