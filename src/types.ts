export interface Recording {
  id: string;
  path: string;
  filename: string;
  dir: string;
  sizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  isVfr: boolean;
  createdAt: string | null;
  modifiedAt: string | null;
  thumbnailPath: string | null;
  sessionId: string | null;
  indexedAt: string;
}

export interface Session {
  id: string;
  startedAt: string;
  endedAt: string | null;
  gameProcess: string | null;
}

export interface SessionEndedEvent {
  session: Session;
  recordingCount: number;
}

export interface Settings {
  watchDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  gameProcessNames: string[];
  compressCrf: number;
  preferNvenc: boolean;
  backgroundServiceEnabled: boolean;
}

export type DaemonEvent =
  | { type: "catalogUpdated" }
  | { type: "sessionStarted"; session: Session }
  | { type: "sessionEnded"; session: Session; recordingCount: number };

export interface BackgroundServiceStatus {
  enabledInSettings: boolean;
  unitActive: boolean;
  message: string;
}

export interface TrimRequest {
  recordingId: string;
  startMs: number;
  endMs: number;
  mode: "precise" | "fast";
  outputMode: "copy" | "replace";
  copyCollision?: "overwrite" | "unique" | null;
}

export interface CompressRequest {
  recordingId: string;
  crf?: number;
  useNvenc?: boolean;
  outputMode: "copy" | "replace";
  copyCollision?: "overwrite" | "unique" | null;
  fps?: number;
}

export interface CopyPathInfo {
  path: string;
  filename: string;
  exists: boolean;
}

export interface JobStatus {
  id: string;
  kind: string;
  status: string;
  progress: number;
  message: string | null;
  outputPath: string | null;
}

export type ViewId = "library" | "session" | "editor" | "settings";
