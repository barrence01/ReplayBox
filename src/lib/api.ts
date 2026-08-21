import { invoke } from "@tauri-apps/api/core";
import type {
  CompressRequest,
  CopyPathInfo,
  DaemonEvent,
  BackgroundServiceStatus,
  JobStatus,
  Recording,
  Session,
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

export function backgroundServiceStatus() {
  return invoke<BackgroundServiceStatus>("background_service_status");
}

export function drainDaemonEvents() {
  return invoke<DaemonEvent[]>("drain_daemon_events");
}

export function listRecordings(query?: string) {
  return invoke<Recording[]>("list_recordings", { query: query ?? null });
}

export function listSessionRecordings(sessionId: string) {
  return invoke<Recording[]>("list_session_recordings", { sessionId });
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

export function getActiveSession() {
  return invoke<Session | null>("get_active_session");
}

export function rescanLibrary() {
  return invoke<number>("rescan_library");
}

export function checkTools() {
  return invoke<[boolean, boolean]>("check_tools");
}

export function resolvedToolPaths() {
  return invoke<[string, string]>("resolved_tool_paths");
}

export function getMediaBaseUrl() {
  return invoke<string>("get_media_base_url");
}

export function nvencAvailable() {
  return invoke<boolean>("nvenc_available");
}

export function getJobStatus(jobId: string) {
  return invoke<JobStatus | null>("get_job_status", { jobId });
}

export function cancelJob(jobId: string) {
  return invoke<void>("cancel_job", { jobId });
}

export function startTrim(request: TrimRequest) {
  return invoke<JobStatus>("start_trim", { request });
}

export function startCompress(request: CompressRequest) {
  return invoke<JobStatus>("start_compress", { request });
}

export { formatBytes, formatTimestamp } from "./format";
