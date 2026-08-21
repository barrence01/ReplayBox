import { useEffect, useRef, useState } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import type { JobStatus, Recording } from "../types";
import {
  deleteRecording,
  formatBytes,
  formatTimestamp,
  startCompress,
  startTrim,
  getMediaBaseUrl,
  recordingFileExists,
  resolveCopyPath,
} from "../lib/api";
import { Timeline } from "../components/Timeline";
import { ConflictModal } from "../components/ConflictModal";
import { ConfirmDeleteModal } from "../components/ConfirmDeleteModal";
import { FolderRecordingList } from "../components/FolderRecordingList";
import { CompressIcon, FolderIcon, ScissorsIcon } from "../components/icons";

type CopyCollision = "overwrite" | "unique";

interface PendingConflict {
  kind: "trimmed" | "compressed";
  filename: string;
}

interface Props {
  recording: Recording;
  folderRecordings: Recording[];
  preferNvenc: boolean;
  jobRunning: boolean;
  onBack: () => void;
  onOpen: (recording: Recording) => void;
  onDeleted: () => void;
  onJobStarted: (job: JobStatus) => void;
  onMissingFile?: () => void;
}

export function EditorView({
  recording,
  folderRecordings,
  preferNvenc,
  jobRunning,
  onBack,
  onOpen,
  onDeleted,
  onJobStarted,
  onMissingFile,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const missingNotified = useRef(false);
  const durationMs = recording.durationMs ?? 0;
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(durationMs || 1);
  const [currentMs, setCurrentMs] = useState(0);
  const [mode, setMode] = useState<"precise" | "fast">("precise");
  const [outputMode, setOutputMode] = useState<"copy" | "replace">("copy");
  const [crf, setCrf] = useState(26);
  const [fps, setFps] = useState<30 | 60>(60);
  const [error, setError] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string>("");
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setStartMs(0);
    setEndMs(recording.durationMs || 1);
    setCurrentMs(0);
    setError(null);
    setConflict(null);
    setConfirmDelete(false);
    missingNotified.current = false;
  }, [recording.id, recording.durationMs]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const base = await getMediaBaseUrl();
        if (!cancelled) {
          setVideoSrc(
            `${base}/media?path=${encodeURIComponent(recording.path)}`,
          );
        }
      } catch (e) {
        if (!cancelled) {
          setVideoSrc("");
          setError(`Media server unavailable: ${String(e)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recording.path]);

  function seekTo(ms: number) {
    setCurrentMs(ms);
    if (videoRef.current) {
      videoRef.current.currentTime = ms / 1000;
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteRecording(recording.id);
      onDeleted();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function openFolder() {
    try {
      await openPath(recording.dir);
    } catch (e) {
      setError(String(e));
    }
  }

  async function beginTrim(copyCollision?: CopyCollision | null) {
    setError(null);
    try {
      const status = await startTrim({
        recordingId: recording.id,
        startMs,
        endMs,
        mode,
        outputMode,
        copyCollision: copyCollision ?? null,
      });
      onJobStarted(status);
    } catch (e) {
      setError(String(e));
    }
  }

  async function beginCompress(copyCollision?: CopyCollision | null) {
    setError(null);
    try {
      const status = await startCompress({
        recordingId: recording.id,
        crf,
        useNvenc: preferNvenc,
        fps,
        outputMode,
        copyCollision: copyCollision ?? null,
      });
      onJobStarted(status);
    } catch (e) {
      setError(String(e));
    }
  }

  async function runTrim() {
    setError(null);
    if (outputMode === "replace") {
      const ok = window.confirm(
        "Replace the original file? This cannot be undone easily.",
      );
      if (!ok) return;
      await beginTrim(null);
      return;
    }
    try {
      const info = await resolveCopyPath(recording.id, "trimmed");
      if (info.exists) {
        setConflict({ kind: "trimmed", filename: info.filename });
        return;
      }
      await beginTrim(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function runCompress() {
    setError(null);
    if (outputMode === "replace") {
      const ok = window.confirm(
        "Replace the original file with the compressed version?",
      );
      if (!ok) return;
      await beginCompress(null);
      return;
    }
    try {
      const info = await resolveCopyPath(recording.id, "compressed");
      if (info.exists) {
        setConflict({ kind: "compressed", filename: info.filename });
        return;
      }
      await beginCompress(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function resolveConflict(choice: CopyCollision) {
    const pending = conflict;
    setConflict(null);
    if (!pending) return;
    if (pending.kind === "trimmed") {
      await beginTrim(choice);
    } else {
      await beginCompress(choice);
    }
  }

  return (
    <section className="view editor">
      {conflict && (
        <ConflictModal
          filename={conflict.filename}
          onCancel={() => setConflict(null)}
          onCreateNew={() => void resolveConflict("unique")}
          onReplace={() => void resolveConflict("overwrite")}
        />
      )}

      {confirmDelete && (
        <ConfirmDeleteModal
          filename={recording.filename}
          busy={deleting}
          onCancel={() => {
            if (!deleting) setConfirmDelete(false);
          }}
          onConfirm={() => void handleDelete()}
        />
      )}

      <div className="editor__toolbar">
        <button type="button" className="linkish" onClick={onBack}>
          ← Back
        </button>
      </div>

      <header className="view__header">
        <div>
          <h1>{recording.filename}</h1>
          <p className="muted path">{recording.path}</p>
        </div>
      </header>

      <div className="editor__layout">
        <div className="editor__player">
          <video
            ref={videoRef}
            key={videoSrc}
            src={videoSrc || undefined}
            controls
            onTimeUpdate={() => {
              if (videoRef.current) {
                setCurrentMs(videoRef.current.currentTime * 1000);
              }
            }}
            onError={() => {
              setError(
                "Video playback failed. Check that the file exists and the media server is running.",
              );
              if (missingNotified.current) return;
              missingNotified.current = true;
              void recordingFileExists(recording.id).then((exists) => {
                if (!exists) {
                  onMissingFile?.();
                }
              });
            }}
          />
          <Timeline
            durationMs={durationMs || 1}
            startMs={startMs}
            endMs={endMs}
            currentMs={currentMs}
            onStartChange={(ms) => {
              setStartMs(ms);
              seekTo(ms);
            }}
            onEndChange={setEndMs}
            onSeek={seekTo}
          />

          <div className="editor__actions">
            <button
              type="button"
              className="editor__action"
              onClick={runTrim}
              disabled={jobRunning}
            >
              <ScissorsIcon />
              <span>{jobRunning ? "Working…" : "Trim"}</span>
            </button>
            <button
              type="button"
              className="editor__action editor__action--secondary"
              onClick={runCompress}
              disabled={jobRunning}
            >
              <CompressIcon />
              <span>{jobRunning ? "Working…" : "Compress"}</span>
            </button>
          </div>

          <div className="editor__output">
            <fieldset className="radio-group">
              <legend className="editor__output-legend">Output</legend>
              <label>
                <input
                  type="radio"
                  checked={outputMode === "copy"}
                  onChange={() => setOutputMode("copy")}
                />
                Create a copy
              </label>
              <label>
                <input
                  type="radio"
                  checked={outputMode === "replace"}
                  onChange={() => setOutputMode("replace")}
                />
                Replace original
              </label>
            </fieldset>
            <label className="stack-label editor__fps">
              Output FPS
              <select
                value={fps}
                onChange={(e) => setFps(Number(e.target.value) as 30 | 60)}
              >
                <option value={60}>60</option>
                <option value={30}>30</option>
              </select>
            </label>
          </div>

          {error && <p className="error">{error}</p>}
        </div>

        <aside className="editor__side">
          <div className="editor__panel">
            <h2>Details</h2>
            <dl className="meta-list">
              <div>
                <dt>Duration</dt>
                <dd>
                  {recording.durationMs != null
                    ? formatTimestamp(recording.durationMs)
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Resolution</dt>
                <dd>
                  {recording.width && recording.height
                    ? `${recording.width}×${recording.height}`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Size</dt>
                <dd>{formatBytes(recording.sizeBytes)}</dd>
              </div>
              <div>
                <dt>Video</dt>
                <dd>{recording.videoCodec ?? "—"}</dd>
              </div>
              <div>
                <dt>Audio</dt>
                <dd>{recording.audioCodec ?? "—"}</dd>
              </div>
              <div>
                <dt>Frame timing</dt>
                <dd>{recording.isVfr ? "VFR" : "CFR / unknown"}</dd>
              </div>
            </dl>

            <button
              type="button"
              className="btn-danger"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting || jobRunning}
            >
              Delete video
            </button>
          </div>

          <div className="editor__panel">
            <h2>Trim</h2>
            <p className="hint">
              Timeline uses timestamps (PTS), not frame numbers — safe for VFR.
            </p>
            <fieldset className="radio-group">
              <label>
                <input
                  type="radio"
                  checked={mode === "precise"}
                  onChange={() => setMode("precise")}
                />
                Precise trim (re-encode, VFR-safe)
              </label>
              <label>
                <input
                  type="radio"
                  checked={mode === "fast"}
                  onChange={() => setMode("fast")}
                />
                Fast trim — may cut on keyframe
              </label>
            </fieldset>

            <h2>Compress</h2>
            <label className="stack-label">
              CRF / quality ({crf})
              <input
                type="range"
                min={18}
                max={32}
                value={crf}
                onChange={(e) => setCrf(Number(e.target.value))}
              />
            </label>
          </div>

          <div className="editor__panel">
            <div className="editor__panel-header">
              <h2>Folder</h2>
              <button
                type="button"
                className="icon-button"
                title="Open folder"
                aria-label="Open folder"
                onClick={() => void openFolder()}
              >
                <FolderIcon size={18} />
              </button>
            </div>
            <FolderRecordingList
              recordings={folderRecordings}
              currentId={recording.id}
              onOpen={onOpen}
            />
          </div>
        </aside>
      </div>
    </section>
  );
}
