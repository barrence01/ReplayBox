import type { Recording } from "../types";

const CACHE_KEY = "replaybox.recordings.v1";

export interface RecordingsCacheSnapshot {
  watchDir: string;
  recordings: Recording[];
  savedAt: string;
}

export function loadRecordingsCache(watchDir: string): Recording[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as RecordingsCacheSnapshot;
    if (parsed.watchDir !== watchDir) {
      return null;
    }
    return parsed.recordings;
  } catch {
    return null;
  }
}

export function saveRecordingsCache(
  watchDir: string,
  recordings: Recording[],
): void {
  try {
    const snapshot: RecordingsCacheSnapshot = {
      watchDir,
      recordings,
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage may be unavailable */
  }
}

export function clearRecordingsCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage may be unavailable */
  }
}
