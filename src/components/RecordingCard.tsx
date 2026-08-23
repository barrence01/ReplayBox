import { convertFileSrc } from "@tauri-apps/api/core";
import type { Recording } from "../types";
import { formatBytes, formatTimestamp } from "../lib/api";

interface Props {
  recording: Recording;
  onOpen: (recording: Recording) => void;
}

export function RecordingCard({ recording, onOpen }: Props) {
  const thumb = recording.thumbnailPath
    ? convertFileSrc(recording.thumbnailPath)
    : null;

  return (
    <button
      type="button"
      className="recording-card"
      onClick={() => onOpen(recording)}
    >
      <div className="recording-card__thumb">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" />
        ) : (
          <div className="recording-card__placeholder">No preview</div>
        )}
        {recording.durationMs != null && (
          <span className="recording-card__duration">
            {formatTimestamp(recording.durationMs)}
          </span>
        )}
      </div>
      <div className="recording-card__meta">
        <div className="recording-card__name" title={recording.filename}>
          {recording.filename}
        </div>
        <div className="recording-card__sub">
          {formatBytes(recording.sizeBytes)}
          {recording.isVfr ? " · VFR" : ""}
          {recording.width && recording.height
            ? ` · ${recording.width}×${recording.height}`
            : ""}
        </div>
      </div>
    </button>
  );
}
