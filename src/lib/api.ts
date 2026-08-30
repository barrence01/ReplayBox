import { invoke } from "@tauri-apps/api/core";
import type {
  CompressRequest,
  CopyPathInfo,
  JobStatus,
  PlaybackInfo,
  Recording,
  Settings,
  TrimRequest,
} from "../types";

export function getSettings() {
  return invoke<Settings>("get_settings");
}

export function checkWatchDir(path: string) {
  return invoke<void>("check_watch_dir", { path });
}

export function updateSettings(settings: Settings) {
  return invoke<Settings>("update_settings", { settings });
}

export interface PlaybackCacheLimits {
  minGb: number;
  maxGb: number;
  defaultGb: number;
  freeGb: number;
  enabled: boolean;
}

export interface PlaybackCacheStats {
  usedBytes: number;
  maxGb: number;
}

export interface PlaybackCacheClearResult {
  freedBytes: number;
}

export function getPlaybackCacheLimits() {
  return invoke<PlaybackCacheLimits>("get_playback_cache_limits");
}

export function getPlaybackCacheStats() {
  return invoke<PlaybackCacheStats>("get_playback_cache_stats");
}

export function clearPlaybackCache() {
  return invoke<PlaybackCacheClearResult>("clear_playback_cache");
}

export function clearAllCache() {
  return invoke<PlaybackCacheClearResult>("clear_all_cache");
}

export function listRecordings(query?: string) {
  return invoke<Recording[]>("list_recordings", { query: query ?? null });
}

export function getRecording(id: string) {
  return invoke<Recording | null>("get_recording", { id });
}

export function recordingFileExists(id: string) {
  return invoke<boolean>("recording_file_exists", { id });
}

export function deleteRecording(id: string) {
  return invoke<void>("delete_recording", { id });
}

export function resolveCopyPath(
  recordingId: string,
  kind: "trimmed" | "compressed",
) {
  return invoke<CopyPathInfo>("resolve_copy_path", { recordingId, kind });
}

export function rescanLibrary() {
  return invoke<void>("rescan_library");
}

export function scanFolder(folderPath: string) {
  return invoke<void>("scan_folder", { folderPath });
}

export function checkTools() {
  return invoke<[boolean, boolean]>("check_tools");
}

export function resolvedToolPaths() {
  return invoke<[string, string]>("resolved_tool_paths");
}

export function getPlaybackInfo(
  recordingId: string,
  options?: {
    forceFallback?: boolean;
    fallbackLevel?: 1 | 2;
  },
) {
  return invoke<PlaybackInfo>("get_playback_info", {
    recordingId,
    forceFallback: options?.forceFallback ?? null,
    fallbackLevel: options?.fallbackLevel ?? null,
  });
}

export function nvencAvailable() {
  return invoke<boolean>("nvenc_available");
}

export function getJobStatus(jobId: string) {
  return invoke<JobStatus | null>("get_job_status", { jobId });
}

export function listJobs() {
  return invoke<JobStatus[]>("list_jobs");
}

export function listPreviewJobs() {
  return invoke<JobStatus[]>("list_preview_jobs");
}

export function cancelJob(jobId: string) {
  return invoke<void>("cancel_job", { jobId });
}

export function cancelPreviewJob(jobId: string) {
  return invoke<void>("cancel_preview_job", { jobId });
}

export function cancelPreviewForRecording(recordingId: string) {
  return invoke<void>("cancel_preview_for_recording", { recordingId });
}

export function prioritizePreviewForRecording(recordingId: string) {
  return invoke<JobStatus>("prioritize_preview_for_recording", { recordingId });
}

export function getJobsPaused() {
  return invoke<boolean>("get_jobs_paused");
}

export function setJobsPaused(paused: boolean) {
  return invoke<boolean>("set_jobs_paused", { paused });
}

export function dismissJob(jobId: string) {
  return invoke<void>("dismiss_job", { jobId });
}

export function dismissPreviewJob(jobId: string) {
  return invoke<void>("dismiss_preview_job", { jobId });
}

export function clearFinishedJobs() {
  return invoke<void>("clear_finished_jobs");
}

export function clearFinishedPreviewJobs() {
  return invoke<void>("clear_finished_preview_jobs");
}

export function startTrim(request: TrimRequest) {
  return invoke<JobStatus>("start_trim", { request });
}

export function startCompress(request: CompressRequest) {
  return invoke<JobStatus>("start_compress", { request });
}

export { formatBytes, formatTimestamp } from "./format";
