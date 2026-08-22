type SessionTimestampRecording = {
  modifiedAt: string | null;
  createdAt: string | null;
  indexedAt: string;
};

const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function recordingActivityAt(
  recording: SessionTimestampRecording,
): string {
  return recording.modifiedAt ?? recording.createdAt ?? recording.indexedAt;
}

export function isWithinLast24Hours(
  iso: string,
  nowMs = Date.now(),
): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const age = nowMs - t;
  return age >= 0 && age <= SESSION_WINDOW_MS;
}
