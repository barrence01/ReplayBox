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

fn default_trim_mode() -> String {
    "fast".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrimRequest {
    pub recording_id: String,
    /// Trim start in milliseconds (timeline uses PTS/time, not frames).
    pub start_ms: f64,
    pub end_ms: f64,
    /// `copy` writes a new file; `replace` atomically replaces the original.
    pub output_mode: String,
    /// When copy dest exists: `overwrite` or `unique` (numbered sibling).
    pub copy_collision: Option<String>,
    /// `fast` stream copy or `precise` re-encode.
    #[serde(default = "default_trim_mode")]
    pub trim_mode: String,
    pub crf: Option<u8>,
    pub use_nvenc: Option<bool>,
    pub fps: Option<u8>,
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
pub struct PlaybackInfo {
    pub url: String,
    /// `direct`, `cache`, or `preparing`
    pub mode: String,
    /// When preparing: `queued` or `processing`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub id: String,
    /// `trim`, `compress`, or `preview`
    pub kind: String,
    /// `queued` | `processing` | `completed` | `failed` | `cancelled`
    pub status: String,
    pub progress: f64,
    pub message: Option<String>,
    pub output_path: Option<String>,
    pub source_path: Option<String>,
    pub source_filename: Option<String>,
    pub queued_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}
