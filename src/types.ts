export interface PlaybackInfo {
  url: string;
  mode: "direct" | "cache" | "preparing";
  queueStatus?: "queued" | "processing" | string | null;
  queuedAt?: string | null;
  startedAt?: string | null;
  queuePosition?: number | null;
  previewStrategy?: "direct" | "stream_copy" | "transcode" | string | null;
  previewInplace?: boolean | null;
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

export type VideoEncoder = "software" | "nvenc" | "vaapi";

export interface HardwareEncodingStatus {
  active: VideoEncoder;
  nvencCompiled: boolean;
  nvencRuntime: boolean;
  vaapiCompiled: boolean;
  vaapiRuntime: boolean;
  vaapiDevice: string | null;
}

export interface Settings {
  watchDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  compressCrf: number;
  preferHardwareEncoding: boolean;
  launchOnStartup: boolean;
  playbackCacheMaxGb: number;
  previewCrf: number;
  /** Scale denominator: 1 = original, 2 = half, 4 = quarter. */
  previewScale: number;
}

export type TrimMode = "fast" | "precise";

export interface TrimRequest {
  recordingId: string;
  startMs: number;
  endMs: number;
  outputMode: "copy" | "replace";
  copyCollision?: "overwrite" | "unique" | null;
  trimMode?: TrimMode;
  crf?: number;
  preferHardwareEncoding?: boolean;
}

export interface CompressRequest {
  recordingId: string;
  crf?: number;
  preferHardwareEncoding?: boolean;
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
  previewStrategy?: "direct" | "stream_copy" | "transcode" | string | null;
}

export interface CatalogScanStarted {
  kind: "full" | "folder" | "delta";
  folderPath?: string;
}

export interface CatalogScanFinished {
  kind: "full" | "folder" | "delta";
  folderPath?: string;
  status: "success" | "error";
  count?: number;
  message?: string;
}

export type ViewId =
  | "library"
  | "session"
  | "editor"
  | "settings"
  | "queues"
  | "about";
