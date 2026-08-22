export interface PlaybackInfo {
  url: string;
  mode: "direct" | "cache" | "preparing";
  queueStatus?: "queued" | "processing" | string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  queuePosition?: number | null;
}

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

export interface Settings {
  watchDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  compressCrf: number;
  preferNvenc: boolean;
  launchOnStartup: boolean;
  playbackCacheMaxGb: number;
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
  kind: "trim" | "compress" | "preview" | string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled" | string;
  progress: number;
  message: string | null;
  outputPath: string | null;
  sourcePath: string | null;
  sourceFilename: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CatalogScanStarted {
  kind: "full" | "folder";
  folderPath?: string;
}

export interface CatalogScanFinished {
  kind: "full" | "folder";
  folderPath?: string;
  status: "success" | "error";
  count?: number;
  message?: string;
}

export type ViewId = "library" | "session" | "editor" | "settings" | "queues";
