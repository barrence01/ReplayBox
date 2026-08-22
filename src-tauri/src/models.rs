use serde::{Deserialize, Serialize};

/// Catalog entry for a single video file on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    pub id: String,
    pub path: String,
    pub filename: String,
    pub dir: String,
    pub size_bytes: Option<i64>,
    /// Duration in milliseconds derived from ffprobe timestamps (not frame counts).
    pub duration_ms: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub is_vfr: bool,
    pub created_at: Option<String>,
    pub modified_at: Option<String>,
    pub thumbnail_path: Option<String>,
    pub session_id: Option<String>,
    pub indexed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRequest {
    pub recording_id: String,
    /// Trim start in milliseconds (timeline uses PTS/time, not frames).
    pub start_ms: f64,
    pub end_ms: f64,
    /// `precise` re-encodes (VFR-safe); `fast` uses stream copy (may cut on keyframe).
    pub mode: String,
    /// `copy` writes a new file; `replace` atomically replaces the original.
    pub output_mode: String,
    /// When copy dest exists: `overwrite` or `unique` (numbered sibling).
    pub copy_collision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressRequest {
    pub recording_id: String,
    pub crf: Option<u8>,
    pub use_nvenc: Option<bool>,
    pub output_mode: String,
    pub copy_collision: Option<String>,
    pub fps: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPathInfo {
    pub path: String,
    pub filename: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogScanStarted {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogScanFinished {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_path: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
    pub output_path: Option<String>,
}
