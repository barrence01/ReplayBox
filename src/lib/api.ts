import { invoke } from "@tauri-apps/api/core";
import type {
  CompressRequest,
  CopyPathInfo,
  JobStatus,
  Recording,
  Session,
  Settings,
  TrimRequest,
} from "../types";

export function getSettings() {
  return invoke<Settings>("get_settings");
}

export function updateSettings(settings: Settings) {
  return invoke<Settings>("update_settings", { settings });
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

/** Format milliseconds as HH:MM:SS.mmm for VFR-safe timeline display. */
export function formatTimestamp(ms: number): string {
  const total = Math.max(0, ms);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  const hh = hours.toString().padStart(2, "0");
  const mm = minutes.toString().padStart(2, "0");
  const ss = seconds.toString().padStart(2, "0");
  const mmm = millis.toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
