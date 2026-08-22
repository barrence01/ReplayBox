use crate::settings::DEFAULT_PLAYBACK_CACHE_MAX_GB;
use serde::Serialize;
use std::path::Path;

const GB: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackCacheLimits {
    pub min_gb: u32,
    pub max_gb: u32,
    pub default_gb: u32,
    pub free_gb: u32,
    pub enabled: bool,
}

/// Derive the preview cache slider maximum (GB) from available disk space.
pub fn compute_playback_cache_max_gb(free_bytes: u64) -> u32 {
    if free_bytes <= GB {
        return 0;
    }

    let free_gb = free_bytes as f64 / GB as f64;
    let thirty_pct = (free_gb * 0.30).floor() as u32;
    let max_gb = if free_gb >= 5.0 {
        thirty_pct.min(10)
    } else {
        thirty_pct
    };

    if max_gb < 1 {
        0
    } else {
        max_gb
    }
}

pub fn playback_cache_limits_for_dir(cache_dir: &Path) -> Result<PlaybackCacheLimits, String> {
    if let Some(parent) = cache_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;

    let free_bytes = fs2::available_space(cache_dir).map_err(|e| e.to_string())?;
    let max_gb = compute_playback_cache_max_gb(free_bytes);
    let free_gb = (free_bytes / GB) as u32;
    let enabled = max_gb >= 1;

    Ok(PlaybackCacheLimits {
        min_gb: if enabled { 1 } else { 0 },
        max_gb,
        default_gb: DEFAULT_PLAYBACK_CACHE_MAX_GB,
        free_gb,
        enabled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_max_disabled_at_one_gb_or_less() {
        assert_eq!(compute_playback_cache_max_gb(GB), 0);
        assert_eq!(compute_playback_cache_max_gb(GB / 2), 0);
    }

    #[test]
    fn compute_max_disabled_when_thirty_percent_below_one_gb() {
        assert_eq!(compute_playback_cache_max_gb(2 * GB), 0);
    }

    #[test]
    fn compute_max_one_gb_at_four_gb_free() {
        assert_eq!(compute_playback_cache_max_gb(4 * GB), 1);
    }

    #[test]
    fn compute_max_three_gb_at_ten_gb_free() {
        assert_eq!(compute_playback_cache_max_gb(10 * GB), 3);
    }

    #[test]
    fn compute_max_capped_at_ten_gb() {
        assert_eq!(compute_playback_cache_max_gb(50 * GB), 10);
        assert_eq!(compute_playback_cache_max_gb(100 * GB), 10);
    }

    #[test]
    fn compute_max_nine_gb_at_thirty_three_gb_free() {
        assert_eq!(compute_playback_cache_max_gb(33 * GB), 9);
    }
}
