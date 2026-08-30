import { useEffect, useMemo, useRef, useState } from "react";
import { useLatestRef } from "../hooks/useRequestGeneration";
import { openPath } from "@tauri-apps/plugin-opener";
import type { JobStatus, Recording } from "../types";
import {
  deleteRecording,
  formatBytes,
  formatTimestamp,
  startCompress,
  startTrim,
  recordingFileExists,
  resolveCopyPath,
} from "../lib/api";
import {
  formatJobElapsed,
  isActiveJob,
  queuePosition,
} from "../lib/queueHelpers";
import { Timeline } from "../components/Timeline";
import { ConflictModal } from "../components/ConflictModal";
import { ConfirmDeleteModal } from "../components/ConfirmDeleteModal";
import { FolderRecordingList } from "../components/FolderRecordingList";
import { VideoPlayer, type VideoPlayerHandle } from "../components/VideoPlayer";
import { CompressIcon, FolderIcon, PauseIcon, PlayIcon, ScissorsIcon } from "../components/icons";
import { clampPlayheadMs } from "../lib/timelinePosition";
import { SEEK_TOLERANCE_SEC } from "../lib/videoSeek";

type CopyCollision = "overwrite" | "unique";

interface PendingConflict {
  kind: "trimmed" | "compressed";
  filename: string;
}

interface Props {
  recording: Recording;
  folderRecordings: Recording[];
  preferNvenc: boolean;
  editJobs: JobStatus[];
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
  editJobs,
  onBack,
  onOpen,
  onDeleted,
  onJobStarted,
  onMissingFile,
}: Props) {
  const playerRef = useRef<VideoPlayerHandle>(null);
  const recordingIdRef = useLatestRef(recording.id);
  const catalogDurationMs = recording.durationMs ?? 0;
  const [timelineDurationMs, setTimelineDurationMs] = useState(
    catalogDurationMs || 1,
  );
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(catalogDurationMs || 1);
  const [currentMs, setCurrentMs] = useState(0);
  const [outputMode, setOutputMode] = useState<"copy" | "replace">("copy");
  const [crf, setCrf] = useState(26);
  const [fps, setFps] = useState<30 | 60>(60);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [timelineLocked, setTimelineLocked] = useState(false);
  const [draftStartMs, setDraftStartMs] = useState<number | null>(null);
  const [draftEndMs, setDraftEndMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const timelineStartMs = draftStartMs ?? startMs;
  const timelineEndMs = draftEndMs ?? endMs;

  const activeEditJob = useMemo(
    () =>
      editJobs.find(
        (j) => isActiveJob(j.status) && j.sourcePath === recording.path,
      ) ?? null,
    [editJobs, recording.path],
  );
  const editBusy = activeEditJob != null || submitting;
  const editQueuePos =
    activeEditJob?.status === "queued"
      ? queuePosition(editJobs, activeEditJob.id)
      : null;
  const editStatusHint = (() => {
    if (!activeEditJob) return null;
    const kind = activeEditJob.kind === "compress" ? "Compress" : "Trim";
    const elapsed = formatJobElapsed(activeEditJob, nowMs);
    if (activeEditJob.status === "queued") {
      const pos = editQueuePos != null ? ` · #${editQueuePos}` : "";
      return `${kind} queued${pos} (${elapsed})`;
    }
    return `${kind} processing (${elapsed})`;
  })();

  useEffect(() => {
    if (!editBusy) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [editBusy]);

  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const initialDuration = catalogDurationMs || 1;
    setTimelineDurationMs(initialDuration);
    setStartMs(0);
    setEndMs(initialDuration);
    setCurrentMs(0);
    setError(null);
    setConflict(null);
    setConfirmDelete(false);
    setDeleting(false);
    setPlaying(false);
    setTimelineLocked(false);
    setDraftStartMs(null);
    setDraftEndMs(null);
    rootRef.current?.closest(".main")?.scrollTo(0, 0);
  }, [recording.id, catalogDurationMs]);

  function handleVideoDuration(ms: number) {
    const videoDurationMs = Math.max(1, Math.round(ms));
    const effectiveDuration =
      catalogDurationMs > 0
        ? Math.min(catalogDurationMs, videoDurationMs)
        : videoDurationMs;
    setTimelineDurationMs(effectiveDuration);
    setEndMs((prev) => Math.min(prev, effectiveDuration));
    setStartMs((prev) => Math.min(prev, effectiveDuration - 1));
    setCurrentMs((prev) => Math.min(prev, effectiveDuration));
  }

  function previewStartTrim(ms: number) {
    const nextEnd = draftEndMs ?? endMs;
    const nextStart = Math.min(ms, nextEnd - 1);
    setDraftStartMs(nextStart);
    setCurrentMs((prev) => {
      if (prev < nextStart || prev > nextEnd) {
        return clampPlayheadMs(prev, nextStart, nextEnd);
      }
      return prev;
    });
  }

  function previewEndTrim(ms: number) {
    const nextStart = draftStartMs ?? startMs;
    const nextEnd = Math.max(ms, nextStart + 1);
    setDraftEndMs(nextEnd);
    setCurrentMs((prev) => {
      if (prev < nextStart || prev > nextEnd) {
        return clampPlayheadMs(prev, nextStart, nextEnd);
      }
      return prev;
    });
  }

  function commitTrimRange(nextStart: number, nextEnd: number) {
    setDraftStartMs(null);
    setDraftEndMs(null);
    setStartMs(nextStart);
    setEndMs(nextEnd);

    const target = clampPlayheadMs(currentMs, nextStart, nextEnd);
    setCurrentMs(target);

    if (timelineLocked) return;
    const videoMs = playerRef.current?.getCurrentMs() ?? 0;
    if (Math.abs(videoMs - target) > SEEK_TOLERANCE_SEC * 1000) {
      playerRef.current?.seekAndLock(target);
    }
  }

  function handleSeekClick(ms: number) {
    if (timelineLocked) return;
    const clamped = clampPlayheadMs(ms, startMs, endMs);
    setCurrentMs(clamped);
    playerRef.current?.seekAndLock(clamped);
  }

  function scrubTo(ms: number) {
    const clamped = clampPlayheadMs(ms, startMs, endMs);
    playerRef.current?.scrubTo(clamped);
  }

  function handleScrubEnd(ms: number) {
    const clamped = clampPlayheadMs(ms, startMs, endMs);
    setCurrentMs(clamped);
    playerRef.current?.endScrubAndLock(clamped);
  }

  async function togglePlayback() {
    const player = playerRef.current;
    if (!player || timelineLocked) return;
    if (!player.isPaused()) {
      player.pause();
      return;
    }
    await player.play();
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
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const status = await startTrim({
        recordingId: recording.id,
        startMs,
        endMs,
        outputMode,
        copyCollision: copyCollision ?? null,
      });
      onJobStarted(status);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function beginCompress(copyCollision?: CopyCollision | null) {
    if (submitting) return;
    setSubmitting(true);
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
    } finally {
      setSubmitting(false);
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
    <section ref={rootRef} className="view editor">
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

      {error && <p className="error">{error}</p>}

      <div className="editor__layout">
        <div className="editor__player">
          <VideoPlayer
            ref={playerRef}
            recordingId={recording.id}
            startMs={startMs}
            endMs={endMs}
            onTimeUpdate={setCurrentMs}
            onPlayingChange={setPlaying}
            onSeekingChange={setTimelineLocked}
            onError={setError}
            onDurationChange={handleVideoDuration}
            onMissingFile={() => {
              const requestedId = recording.id;
              void recordingFileExists(requestedId).then((exists) => {
                if (!exists && recordingIdRef.current === requestedId) {
                  onMissingFile?.();
                }
              });
            }}
          />
          <div className="editor__transport">
            <button
              type="button"
              className="icon-button"
              title={playing ? "Pause" : "Play"}
              aria-label={playing ? "Pause" : "Play"}
              disabled={timelineLocked}
              onClick={() => void togglePlayback()}
            >
              {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
            </button>
            <span className="editor__transport-time">
              {formatTimestamp(currentMs)}
            </span>
            <span className="muted editor__transport-range">
              {formatTimestamp(timelineStartMs)} – {formatTimestamp(timelineEndMs)}
            </span>
          </div>
          <Timeline
            durationMs={timelineDurationMs}
            startMs={timelineStartMs}
            endMs={timelineEndMs}
            currentMs={currentMs}
            disabled={timelineLocked}
            onStartChange={previewStartTrim}
            onEndChange={previewEndTrim}
            onStartCommit={(ms) => {
              commitTrimRange(ms, draftEndMs ?? endMs);
            }}
            onEndCommit={(ms) => {
              commitTrimRange(draftStartMs ?? startMs, ms);
            }}
            onSeekClick={handleSeekClick}
            onScrubStart={() => playerRef.current?.beginScrub()}
            onScrub={scrubTo}
            onScrubEnd={handleScrubEnd}
          />

          <div className="editor__actions">
            <button
              type="button"
              className="editor__action"
              onClick={runTrim}
              disabled={editBusy}
            >
              <ScissorsIcon />
              <span>{editBusy ? "Working…" : "Trim"}</span>
            </button>
            <button
              type="button"
              className="editor__action editor__action--secondary"
              onClick={runCompress}
              disabled={editBusy}
            >
              <CompressIcon />
              <span>{editBusy ? "Working…" : "Compress"}</span>
            </button>
          </div>
          {editStatusHint && (
            <p className="muted editor__job-status">{editStatusHint}</p>
          )}

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

          <div className="editor__job-options">
            <h2>Trim</h2>
            <p className="hint">
              Timeline uses timestamps (PTS), not frame numbers, safe for VFR.
            </p>
            <p className="hint">
              Instant trim (stream copy). The start may snap to the nearest
              keyframe — you might see 1–2 s of black/frozen video at the
              beginning while audio plays normally.
            </p>

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
              <span className="range-ends hint" aria-hidden="true">
                <span>Better quality / bigger file</span>
                <span>Worse quality / smaller file</span>
              </span>
            </label>
          </div>
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
              disabled={deleting}
            >
              Delete video
            </button>
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
